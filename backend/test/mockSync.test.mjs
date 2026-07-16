// Mock "Demo Bank" cursor sync against a scratch SQLite file:
// deterministic ledger, cursor advance, incremental syncs delivering only new
// items, idempotent re-sync from the same cursor, encrypted-at-rest token.
//
// Tests in this file are stateful and run in declaration order (node:test
// default in-file behavior). Env is pinned before any src import so the store
// opens the scratch DB, never data/finance-os.sqlite.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfos-mock-sync-test-'))
const dbPath = path.join(scratchDir, 'mock-sync-test.sqlite')
process.env.PFOS_DATA_DIR = scratchDir
process.env.PFOS_DB_PATH = dbPath
process.env.PFOS_MASTER_KEY = 'pfos-unit-test-master-key-0123456789'
process.env.PLAID_CLIENT_ID = ''
process.env.PLAID_SECRET = ''

const store = await import('../src/store.mjs')
const mock = await import('../src/providers/mock.mjs')
const { encryptSecret } = await import('../src/cryptoVault.mjs')

const PLAINTEXT_TOKEN = 'mock-access-token-demo'
const OPENING_CENTS = { mock_demo_checking: 320000, mock_demo_credit: 85000, mock_demo_brokerage: 1200000 }
const CREDIT_ACCOUNT = 'mock_demo_credit'

function mockRows() {
  return store.readDb().transactions.filter((t) => t.provider === 'mock')
}

function cursorParts(cursor) {
  const [version, anchor, delivered] = String(cursor).split('|')
  return { version, anchor, delivered: Number(delivered) }
}

// Shared state across the ordered tests below.
const db = store.readDb()
let connection = null
let firstSyncAdded = 0

test('link: exchangePublicToken stores only an encrypted token', async () => {
  await mock.exchangePublicToken(db, 'mock-public-token', {})
  connection = db.connections.find((c) => c.id === 'mock_demo_bank')
  assert.ok(connection, 'connection must exist after link')
  assert.equal(connection.provider, 'mock')
  assert.equal(connection.status, 'active')
  assert.equal(connection.cursor, null)
  // Real cryptoVault path: AES-256-GCM envelope, no plaintext anywhere in it.
  assert.equal(connection.token.alg, 'aes-256-gcm')
  for (const field of ['iv', 'tag', 'data']) assert.equal(typeof connection.token[field], 'string')
  assert.ok(!JSON.stringify(connection.token).includes(PLAINTEXT_TOKEN))
})

test('first sync delivers the full deterministic backlog and sets the cursor', async () => {
  const result = await mock.syncConnection(db, connection)
  assert.equal(result.ok, true)
  assert.ok(result.added > 150, `expected a ~12-month backlog, got ${result.added}`)
  firstSyncAdded = result.added

  const { version, anchor, delivered } = cursorParts(connection.cursor)
  assert.equal(version, 'mockv1')
  assert.match(anchor, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(delivered, result.added)

  // Every delivered row is persisted, ids are the deterministic mock_txn_<n>
  // sequence with no duplicates.
  const rows = mockRows()
  assert.equal(rows.length, result.added)
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length)
  for (const row of rows) {
    assert.match(row.id, /^mock_txn_\d+$/)
    assert.equal(row.source, 'mock_sync')
    assert.ok(row.accountId in OPENING_CENTS, `unexpected account ${row.accountId}`)
  }
})

test('reported balances reconcile to the cent against delivered transactions', () => {
  const accounts = store.readDb().accounts.filter((a) => a.provider === 'mock')
  assert.equal(accounts.length, 3)
  const sums = new Map(Object.keys(OPENING_CENTS).map((id) => [id, 0]))
  for (const row of mockRows()) {
    sums.set(row.accountId, sums.get(row.accountId) + Math.round(row.amount * 100))
  }
  for (const account of accounts) {
    const opening = OPENING_CENTS[account.id]
    const flow = sums.get(account.id)
    const expected = account.id === CREDIT_ACCOUNT ? opening + flow : opening - flow
    assert.equal(Math.round(account.balance * 100), expected, `${account.id} must reconcile exactly`)
  }
})

test('incremental sync returns only new items (2-5 per trickle batch)', async () => {
  const idsBefore = new Set(mockRows().map((r) => r.id))
  const before = cursorParts(connection.cursor)

  const result = await mock.syncConnection(db, connection)
  assert.equal(result.ok, true)
  assert.ok(result.added >= 2 && result.added <= 5, `trickle batch must be 2-5, got ${result.added}`)

  const after = cursorParts(connection.cursor)
  assert.equal(after.anchor, before.anchor, 'anchor is captured once and never moves')
  assert.equal(after.delivered, before.delivered + result.added)

  const rows = mockRows()
  assert.equal(rows.length, idsBefore.size + result.added)
  const newRows = rows.filter((r) => !idsBefore.has(r.id))
  assert.equal(newRows.length, result.added, 'every delivered item must be genuinely new')
})

test('re-sync from the same cursor is idempotent: same rows, zero duplicates', async () => {
  const replayCursor = connection.cursor
  const firstPass = await mock.syncConnection(db, connection)
  const snapshot = new Map(mockRows().map((r) => [r.id, `${r.date}|${r.amount}|${r.merchant}`]))
  const cursorAfterFirstPass = connection.cursor

  // Rewind and replay the exact same sync.
  connection.cursor = replayCursor
  const secondPass = await mock.syncConnection(db, connection)

  assert.equal(secondPass.added, firstPass.added, 'same cursor must deliver the same batch size')
  assert.equal(connection.cursor, cursorAfterFirstPass, 'cursor must land in the same place')
  const replayed = new Map(mockRows().map((r) => [r.id, `${r.date}|${r.amount}|${r.merchant}`]))
  assert.equal(replayed.size, snapshot.size, 'no new rows may appear on replay')
  assert.deepEqual(replayed, snapshot, 'every row must be byte-identical after replay')
})

test('re-link resets the cursor but the deterministic ledger never duplicates', async () => {
  const countBefore = mockRows().length
  await mock.exchangePublicToken(db, 'mock-public-token-again', {})
  const relinked = db.connections.find((c) => c.id === 'mock_demo_bank')
  assert.equal(relinked.cursor, null, 're-link restarts the timeline')

  const result = await mock.syncConnection(db, relinked)
  assert.equal(result.ok, true)
  // The re-delivered backlog upserts onto identical ids: row count cannot grow
  // past what the previous timeline already delivered.
  assert.equal(mockRows().length, countBefore)
  connection = relinked
})

test('persisting through writeDb round-trips the connection and leaks no plaintext token', () => {
  store.writeDb(db)
  const persisted = store.readDb().connections.find((c) => c.id === 'mock_demo_bank')
  assert.ok(persisted, 'connection must survive persistence')
  assert.equal(persisted.token.alg, 'aes-256-gcm')
  assert.ok(!JSON.stringify(persisted.token).includes(PLAINTEXT_TOKEN))

  // At-rest check: the raw SQLite file bytes (including WAL) must not contain
  // the plaintext token anywhere.
  const plaintext = Buffer.from(PLAINTEXT_TOKEN)
  for (const suffix of ['', '-wal']) {
    const file = `${dbPath}${suffix}`
    if (!fs.existsSync(file)) continue
    assert.ok(!fs.readFileSync(file).includes(plaintext), `plaintext token found in ${file}`)
  }
})

test('a tampered token fails the sync with a 401 (auth) — never a silent success', async () => {
  const sabotaged = { ...connection, token: encryptSecret('wrong-token') }
  await assert.rejects(
    () => mock.syncConnection(db, sabotaged),
    (err) => err.status === 401 && /re-link/i.test(err.message),
  )
})
