// "Demo Bank" mock provider.
//
// Implements the same adapter interface as the Plaid adapter (createLinkToken /
// exchangePublicToken / syncConnection / check) but is generated entirely
// locally from a deterministic seeded PRNG, so a fresh link always produces the
// same ~12 months of realistic data. It deliberately exercises the REAL token
// path: the fake access token goes through cryptoVault.encryptSecret at link
// time and decryptSecret at sync time, exactly like Plaid tokens.
//
// Sign convention matches the Plaid adapter and the demo seed in store.mjs:
// positive amount = money OUT (spend), negative amount = money IN (income).
// Asset balances therefore move by -amount, credit-card owed balances by
// +amount, so `opening balance +/- sum(delivered amounts) = reported balance`
// reconciles to the cent (all math is done in integer cents).
import crypto from 'node:crypto'
import { decryptSecret, encryptSecret } from '../cryptoVault.mjs'
import { upsertAccount, upsertTransaction } from '../store.mjs'

const SEED = 0x5eedfeed
const MOCK_ACCESS_TOKEN = 'mock-access-token-demo'
const CONNECTION_ID = 'mock_demo_bank'
const CURSOR_VERSION = 'mockv1'

const ACCOUNTS = [
  {
    key: 'checking',
    id: 'mock_demo_checking',
    name: 'Demo Checking',
    officialName: 'Demo Bank Everyday Checking',
    kind: 'checking',
    subtype: 'checking',
    mask: '4821',
    openingCents: 320000,
  },
  {
    key: 'credit',
    id: 'mock_demo_credit',
    name: 'Demo Credit Card',
    officialName: 'Demo Bank Cash Rewards Card',
    kind: 'credit',
    subtype: 'credit card',
    mask: '7710',
    openingCents: 85000,
  },
  {
    key: 'brokerage',
    id: 'mock_demo_brokerage',
    name: 'Demo Brokerage',
    officialName: 'Demo Bank Self-Directed Brokerage',
    kind: 'investment',
    subtype: 'brokerage',
    mask: '3395',
    openingCents: 1200000,
  },
]

const ACCOUNT_BY_KEY = new Map(ACCOUNTS.map((a) => [a.key, a]))

// Deterministic PRNG (mulberry32). Same seed -> same stream, no Math.random.
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randCents(rng, minDollars, spanDollars) {
  return Math.round(minDollars * 100 + rng() * spanDollars * 100)
}

function todayText() {
  return new Date().toISOString().slice(0, 10)
}

// The 12 calendar months ending at the anchor date's month, oldest first.
function lastTwelveMonths(anchorDate) {
  const [year, month] = anchorDate.slice(0, 7).split('-').map(Number)
  const months = []
  for (let delta = -11; delta <= 0; delta += 1) {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1))
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return months
}

function dateFor(month, day) {
  return `${month}-${String(day).padStart(2, '0')}`
}

function isQuarterEnd(month) {
  return Number(month.slice(5)) % 3 === 0
}

// Full historical backlog for a given anchor date. The anchor is captured into
// the cursor on the first sync, so the backlog (and every mock_txn_<n> id in
// it) stays byte-for-byte identical on later syncs and across restarts.
const backlogCache = new Map()

function buildBacklog(anchorDate) {
  if (backlogCache.has(anchorDate)) return backlogCache.get(anchorDate)
  const rng = mulberry32(SEED)
  const events = []
  let seq = 0
  const push = (accountKey, month, day, merchant, description, amountCents, category) => {
    events.push({ accountKey, date: dateFor(month, day), merchant, description, amountCents, category, seq: seq++ })
  }

  for (const month of lastTwelveMonths(anchorDate)) {
    // Checking: payroll twice a month, rent, utilities, groceries, card autopay,
    // and an automated brokerage contribution transfer.
    push('checking', month, 1, 'Acme Corp Payroll', 'ACME CORP DIRECT DEPOSIT', -180000, 'Income')
    push('checking', month, 15, 'Acme Corp Payroll', 'ACME CORP DIRECT DEPOSIT', -180000, 'Income')
    push('checking', month, 2, 'Oakwood Apartments', 'OAKWOOD APTS RENT PAYMENT', 145000, 'Housing')
    push('checking', month, 8, 'City Power & Water', 'CITY POWER AND WATER UTILITY BILL', randCents(rng, 88, 46), 'Utilities')
    push('checking', month, 12, 'Costco', 'COSTCO WHOLESALE', randCents(rng, 112, 58), 'Groceries')
    const payment = randCents(rng, 330, 120)
    push('checking', month, 20, 'Demo Credit Card Payment', 'DEMO BANK CARD AUTOPAY', payment, 'Transfer')
    push('credit', month, 20, 'Payment Received', 'DEMO BANK CARD AUTOPAY - THANK YOU', -payment, 'Transfer')
    // Both legs of internal transfers are category 'Transfer': they must stay
    // in the ledger (balance reconciliation depends on them) but are neither
    // income nor spending, and store.mjs excludes 'Transfer' from cashflow.
    push('checking', month, 25, 'Brokerage Transfer', 'TRANSFER TO DEMO BROKERAGE', 40000, 'Transfer')
    push('brokerage', month, 25, 'Contribution', 'ACH CONTRIBUTION FROM DEMO CHECKING', -40000, 'Transfer')

    // Credit card purchases across realistic categories.
    push('credit', month, 5, 'Netflix', 'NETFLIX.COM SUBSCRIPTION', 1549, 'Subscriptions')
    push('credit', month, 9, 'Spotify', 'SPOTIFY PREMIUM', 1199, 'Subscriptions')
    push('credit', month, 6, 'Whole Foods Market', 'WHOLE FOODS MKT 10259', randCents(rng, 62, 48), 'Groceries')
    push('credit', month, 19, 'Safeway', 'SAFEWAY STORE 1200', randCents(rng, 46, 42), 'Groceries')
    push('credit', month, 4, 'Chipotle', 'CHIPOTLE ONLINE', randCents(rng, 11, 9), 'Dining')
    push('credit', month, 13, 'Starbucks', 'STARBUCKS STORE 1204', randCents(rng, 5, 7), 'Dining')
    push('credit', month, 22, 'Local Thai Kitchen', 'LOCAL THAI KITCHEN', randCents(rng, 24, 22), 'Dining')
    push('credit', month, 10, 'Shell', 'SHELL OIL 5744', randCents(rng, 34, 20), 'Transport')
    push('credit', month, 24, 'Shell', 'SHELL OIL 5744', randCents(rng, 32, 18), 'Transport')
    push('credit', month, 16, 'Amazon', 'AMZN MKTP US', randCents(rng, 24, 88), 'Shopping')

    // Brokerage: quarterly dividend on top of the monthly contribution.
    if (isQuarterEnd(month)) {
      push('brokerage', month, 27, 'DEMO ETF Dividend', 'DEMO TOTAL MARKET ETF DIVIDEND', -randCents(rng, 12, 14), 'Investment')
    }
  }

  const backlog = events
    .filter((e) => e.date <= anchorDate)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq))
    .map((e, index) => ({ ...e, index }))
  backlogCache.set(anchorDate, backlog)
  return backlog
}

// Post-backlog "new activity" stream. Event i is fully determined by i (its own
// PRNG seed), so the same cursor position always yields the same transaction —
// stable ids, stable amounts, no duplicates ever.
const TRICKLE_POOL = [
  { accountKey: 'credit', merchant: 'Starbucks', description: 'STARBUCKS STORE 1204', category: 'Dining', min: 4.5, span: 7 },
  { accountKey: 'credit', merchant: 'Chipotle', description: 'CHIPOTLE ONLINE', category: 'Dining', min: 11, span: 8 },
  { accountKey: 'credit', merchant: 'Shell', description: 'SHELL OIL 5744', category: 'Transport', min: 30, span: 22 },
  { accountKey: 'credit', merchant: 'Amazon', description: 'AMZN MKTP US', category: 'Shopping', min: 12, span: 60 },
  { accountKey: 'checking', merchant: 'Farmers Market', description: 'FARMERS MARKET POS DEBIT', category: 'Groceries', min: 16, span: 28 },
  { accountKey: 'credit', merchant: 'Local Thai Kitchen', description: 'LOCAL THAI KITCHEN', category: 'Dining', min: 22, span: 20 },
]

function trickleEvent(index) {
  const rng = mulberry32((SEED ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0)
  const pick = TRICKLE_POOL[Math.floor(rng() * TRICKLE_POOL.length)]
  return {
    accountKey: pick.accountKey,
    merchant: pick.merchant,
    description: pick.description,
    category: pick.category,
    amountCents: randCents(rng, pick.min, pick.span),
    index,
  }
}

function eventAt(backlog, index) {
  return index < backlog.length ? backlog[index] : trickleEvent(index)
}

// Reported balance after `count` delivered events, in cents. Asset accounts:
// opening - sum(amounts); credit (owed): opening + sum(amounts). Integer cents
// throughout, so opening + delivered amounts reconciles exactly.
function balancesAfter(backlog, count) {
  const totals = { checking: 0, credit: 0, brokerage: 0 }
  for (let i = 0; i < count; i += 1) {
    const e = eventAt(backlog, i)
    totals[e.accountKey] += e.amountCents
  }
  const balances = {}
  for (const acc of ACCOUNTS) {
    balances[acc.key] = acc.kind === 'credit'
      ? acc.openingCents + totals[acc.key]
      : acc.openingCents - totals[acc.key]
  }
  return balances
}

function parseCursor(cursor) {
  if (!cursor) return null
  const parts = String(cursor).split('|')
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) return null
  const anchor = parts[1]
  const delivered = Number(parts[2])
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || !Number.isInteger(delivered) || delivered < 0) return null
  return { anchor, delivered }
}

function toTransaction(event, date) {
  return {
    id: `mock_txn_${event.index}`,
    source: 'mock_sync',
    provider: 'mock',
    accountId: ACCOUNT_BY_KEY.get(event.accountKey).id,
    date,
    merchant: event.merchant,
    description: event.description,
    amount: event.amountCents / 100,
    currency: 'USD',
    category: event.category,
    pending: false,
    raw: { mockIndex: event.index },
  }
}

export async function createLinkToken() {
  return {
    link_token: `mock-link-${crypto.randomUUID()}`,
    expiration: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    provider: 'mock',
  }
}

export async function exchangePublicToken(db, publicToken, metadata = {}) {
  void publicToken
  void metadata
  const now = new Date().toISOString()
  const connection = {
    id: CONNECTION_ID,
    provider: 'mock',
    providerItemId: 'mock_item_demo_bank',
    displayName: 'Demo Bank',
    cursor: null, // re-linking restarts the deterministic timeline
    token: encryptSecret(MOCK_ACCESS_TOKEN), // real encryption path, same as Plaid
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  const existing = db.connections.findIndex((c) => c.id === connection.id)
  if (existing >= 0) db.connections[existing] = { ...db.connections[existing], ...connection }
  else db.connections.push(connection)
  return { id: connection.id, provider: connection.provider, displayName: connection.displayName }
}

export async function syncConnection(db, connection) {
  // Exercise the real decryption path exactly like the Plaid adapter does.
  const accessToken = decryptSecret(connection.token)
  if (accessToken !== MOCK_ACCESS_TOKEN) {
    const err = new Error('mock access token is invalid; re-link Demo Bank')
    err.status = 400
    throw err
  }

  const today = todayText()
  const parsed = parseCursor(connection.cursor)
  const anchor = parsed?.anchor || today
  const start = parsed?.delivered || 0
  const backlog = buildBacklog(anchor)

  // First sync (or resumed partial backlog) delivers the remaining backlog in
  // full; afterwards each sync trickles a small deterministic batch of 2-5 new
  // transactions dated today.
  const deliveries = []
  if (start < backlog.length) {
    for (const event of backlog.slice(start)) deliveries.push({ event, date: event.date })
  } else {
    const batchSize = 2 + (start % 4) // deterministic 2..5 given cursor position
    for (let i = start; i < start + batchSize; i += 1) {
      deliveries.push({ event: trickleEvent(i), date: today })
    }
  }

  let added = 0
  for (const { event, date } of deliveries) {
    const record = toTransaction(event, date)
    upsertTransaction(db, record)
    // Mirror into the in-memory snapshot: the server calls writeDb(db) after a
    // sync, which re-upserts db.transactions — if a re-delivered transaction
    // (e.g. after a re-link reset the cursor) only went to SQLite, the stale
    // snapshot row would immediately overwrite it back.
    if (db && Array.isArray(db.transactions)) {
      const idx = db.transactions.findIndex((t) => t.id === record.id)
      if (idx >= 0) db.transactions[idx] = { ...db.transactions[idx], ...record }
      else db.transactions.push(record)
    }
    added += 1
  }

  const end = start + deliveries.length
  const balances = balancesAfter(backlog, end)
  const now = new Date().toISOString()
  let accountsTouched = 0
  for (const acc of ACCOUNTS) {
    const balance = balances[acc.key] / 100
    const record = {
      id: acc.id,
      provider: 'mock',
      connectionId: connection.id,
      name: acc.name,
      officialName: acc.officialName,
      institution: connection.displayName,
      mask: acc.mask,
      kind: acc.kind,
      subtype: acc.subtype,
      balance,
      availableBalance: acc.kind === 'credit' ? null : balance,
      currency: 'USD',
      lastSyncAt: now,
    }
    upsertAccount(db, record)
    // Keep the in-memory snapshot coherent too: the server persists the whole
    // snapshot via writeDb() after a sync, and a stale accounts array would
    // silently roll balances back to their pre-sync values.
    if (db && Array.isArray(db.accounts)) {
      const idx = db.accounts.findIndex((a) => a.id === record.id)
      if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...record }
      else db.accounts.push(record)
    }
    accountsTouched += 1
  }

  connection.cursor = `${CURSOR_VERSION}|${anchor}|${end}`
  connection.lastSyncAt = now
  connection.lastError = null
  connection.updatedAt = now
  return { connectionId: connection.id, ok: true, accountsTouched, added, modified: 0, removed: 0 }
}

export async function check() {
  return {
    provider: 'mock',
    configured: true,
    ok: true,
    message: 'Demo Bank is a local mock provider; no credentials required.',
  }
}
