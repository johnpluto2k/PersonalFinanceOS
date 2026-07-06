import { config } from '../config.mjs'
import { decryptSecret, encryptSecret } from '../cryptoVault.mjs'
import { removeTransaction, upsertAccount, upsertTransaction } from '../store.mjs'

const baseByEnv = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
}

function plaidBaseUrl() {
  return baseByEnv[config.plaid.env] || baseByEnv.sandbox
}

function ensurePlaidConfigured() {
  if (!config.plaid.clientId || !config.plaid.secret) {
    const err = new Error('Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.')
    err.status = 400
    throw err
  }
}

async function plaidFetch(path, body) {
  ensurePlaidConfigured()
  const res = await fetch(`${plaidBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.plaid.clientId,
      secret: config.plaid.secret,
      ...body,
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.error_message || json.error_code || `Plaid request failed: ${res.status}`)
    err.status = res.status
    err.details = json
    throw err
  }
  return json
}

export async function createLinkToken() {
  return plaidFetch('/link/token/create', {
    user: { client_user_id: 'local-owner' },
    client_name: 'Personal Finance OS',
    products: config.plaid.products,
    country_codes: config.plaid.countryCodes,
    language: 'en',
    transactions: { days_requested: 730 },
  })
}

export async function exchangePublicToken(db, publicToken, metadata = {}) {
  const exchanged = await plaidFetch('/item/public_token/exchange', { public_token: publicToken })
  const now = new Date().toISOString()
  const connection = {
    id: `plaid_${exchanged.item_id}`,
    provider: 'plaid',
    providerItemId: exchanged.item_id,
    displayName: metadata.institution?.name || metadata.institution_name || 'Linked institution',
    cursor: null,
    token: encryptSecret(exchanged.access_token),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  const existing = db.connections.findIndex((c) => c.id === connection.id)
  if (existing >= 0) db.connections[existing] = { ...db.connections[existing], ...connection }
  else db.connections.push(connection)
  return { id: connection.id, provider: connection.provider, displayName: connection.displayName }
}

function mapPlaidAccount(account, connection) {
  const kindByType = {
    depository: account.subtype === 'savings' ? 'savings' : 'checking',
    credit: 'credit',
    loan: account.subtype === 'student' ? 'student_loan' : 'loan',
    investment: 'investment',
    brokerage: 'investment',
  }
  return {
    id: `plaid_${account.account_id}`,
    provider: 'plaid',
    connectionId: connection.id,
    name: account.name,
    officialName: account.official_name,
    institution: connection.displayName,
    mask: account.mask,
    kind: kindByType[account.type] || 'other',
    subtype: account.subtype,
    balance: Number(account.balances?.current ?? account.balances?.available ?? 0),
    availableBalance: account.balances?.available ?? null,
    currency: account.balances?.iso_currency_code || 'USD',
  }
}

function mapPlaidTransaction(tx) {
  return {
    id: `plaid_${tx.transaction_id}`,
    source: 'plaid_sync',
    provider: 'plaid',
    accountId: `plaid_${tx.account_id}`,
    date: tx.date,
    merchant: tx.merchant_name || tx.name,
    description: tx.original_description || tx.name,
    amount: Number(tx.amount || 0),
    currency: tx.iso_currency_code || 'USD',
    category: tx.personal_finance_category?.primary || tx.category?.[0] || 'Uncategorized',
    pending: Boolean(tx.pending),
    raw: tx,
  }
}

export async function syncPlaidConnection(db, connection) {
  const accessToken = decryptSecret(connection.token)
  let cursor = connection.cursor || null
  let hasMore = true
  let added = 0
  let modified = 0
  let removed = 0
  let accountsTouched = 0

  while (hasMore) {
    const page = await plaidFetch('/transactions/sync', {
      access_token: accessToken,
      cursor,
      count: 500,
      options: { include_original_description: true },
    })
    for (const account of page.accounts || []) {
      upsertAccount(db, mapPlaidAccount(account, connection))
      accountsTouched += 1
    }
    for (const tx of page.added || []) {
      upsertTransaction(db, mapPlaidTransaction(tx))
      added += 1
    }
    for (const tx of page.modified || []) {
      upsertTransaction(db, mapPlaidTransaction(tx))
      modified += 1
    }
    for (const tx of page.removed || []) {
      removeTransaction(db, `plaid_${tx.transaction_id}`)
      removed += 1
    }
    cursor = page.next_cursor
    hasMore = Boolean(page.has_more)
  }

  connection.cursor = cursor
  connection.updatedAt = new Date().toISOString()
  return { connectionId: connection.id, accountsTouched, added, modified, removed }
}
