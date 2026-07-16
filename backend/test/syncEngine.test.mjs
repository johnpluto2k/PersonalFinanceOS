// Resilient sync engine: error classification, bounded retry/backoff for
// transient failures, fail-fast for permanent ones, and isolation between
// connections in the same sync pass.
//
// All providers here are injected fakes registered through the real registry
// (registerProvider) — no network, no SQLite writes (the fake syncConnection
// implementations never touch the db argument). Env is still pinned to a
// scratch path before import so nothing can reach the real data DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfos-sync-engine-test-'))
process.env.PFOS_DATA_DIR = scratchDir
process.env.PFOS_DB_PATH = path.join(scratchDir, 'sync-engine-test.sqlite')
process.env.PFOS_MASTER_KEY = 'pfos-unit-test-master-key-0123456789'
process.env.PLAID_CLIENT_ID = ''
process.env.PLAID_SECRET = ''

const { registerProvider } = await import('../src/providers/index.mjs')
const { classifyError, clearSyncFailures, syncWithRetry } = await import('../src/syncEngine.mjs')

let fakeSeq = 0
function fakeProvider(syncImpl) {
  const id = `fake-sync-${(fakeSeq += 1)}`
  registerProvider({
    id,
    label: id,
    linkMode: 'direct',
    isConfigured: () => true,
    createLinkToken: async () => ({}),
    exchangePublicToken: async () => ({}),
    syncConnection: syncImpl,
    check: async () => ({ provider: id, configured: true, ok: true }),
  })
  return id
}

function connectionFor(provider, overrides = {}) {
  return { id: `conn_${provider}`, provider, status: 'active', consecutiveFailures: 0, ...overrides }
}

function errorWith(overrides = {}) {
  const err = new Error(overrides.message || 'boom')
  for (const [key, value] of Object.entries(overrides)) err[key] = value
  return err
}

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

test('classifyError: config-level failures', () => {
  assert.equal(classifyError(errorWith({ message: 'Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.' })), 'config')
  assert.equal(classifyError(errorWith({ message: 'PFOS_MASTER_KEY is required before storing real provider tokens.' })), 'config')
  assert.equal(classifyError(errorWith({ details: { error_code: 'INVALID_API_KEYS' } })), 'config')
  assert.equal(classifyError(errorWith({ details: { error_code: 'INVALID_CLIENT_ID' } })), 'config')
})

test('classifyError: auth failures (re-link remediation)', () => {
  assert.equal(classifyError(errorWith({ status: 401 })), 'auth')
  assert.equal(classifyError(errorWith({ status: 403 })), 'auth')
  assert.equal(classifyError(errorWith({ details: { error_code: 'ITEM_LOGIN_REQUIRED' } })), 'auth')
  assert.equal(classifyError(errorWith({ details: { error_code: 'INVALID_ACCESS_TOKEN' } })), 'auth')
})

test('classifyError: transient classes (rate-limit, provider-down)', () => {
  assert.equal(classifyError(errorWith({ status: 429 })), 'rate-limit')
  assert.equal(classifyError(errorWith({ details: { error_code: 'RATE_LIMIT_EXCEEDED' } })), 'rate-limit')
  assert.equal(classifyError(errorWith({ status: 500 })), 'provider-down')
  assert.equal(classifyError(errorWith({ status: 503 })), 'provider-down')
  assert.equal(classifyError(errorWith({ message: 'fetch failed' })), 'provider-down')
  const network = errorWith({ message: 'fetch failed to connect' })
  network.cause = { code: 'ECONNREFUSED' }
  assert.equal(classifyError(network), 'provider-down')
})

test('classifyError: anything else is unknown (fail fast, stay visible)', () => {
  assert.equal(classifyError(errorWith({ message: 'TypeError: x is not a function' })), 'unknown')
  assert.equal(classifyError(null), 'unknown')
  assert.equal(classifyError(errorWith({ status: 404 })), 'unknown')
})

// ---------------------------------------------------------------------------
// syncWithRetry
// ---------------------------------------------------------------------------

test('success on the first attempt clears prior failure bookkeeping', async () => {
  let calls = 0
  const provider = fakeProvider(async (db, connection) => {
    calls += 1
    return { connectionId: connection.id, ok: true, added: 3 }
  })
  const connection = connectionFor(provider, {
    consecutiveFailures: 2,
    lastError: 'old failure',
    lastErrorClass: 'provider-down',
  })
  const result = await syncWithRetry({}, connection)
  assert.equal(calls, 1)
  assert.deepEqual(result, { connectionId: connection.id, ok: true, added: 3, attempts: 1 })
  assert.equal(connection.consecutiveFailures, 0)
  assert.equal(connection.lastError, null)
  assert.equal(connection.lastErrorClass, null)
})

test('transient failure retries with backoff and succeeds within 3 attempts', async () => {
  let calls = 0
  const provider = fakeProvider(async () => {
    calls += 1
    if (calls < 3) {
      const err = errorWith({ message: 'fetch failed' })
      err.cause = { code: 'ECONNRESET' }
      throw err
    }
    return { connectionId: 'x', ok: true, added: 1 }
  })
  const connection = connectionFor(provider)
  const started = Date.now()
  const result = await syncWithRetry({}, connection)
  const elapsed = Date.now() - started
  assert.equal(calls, 3)
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 3)
  assert.equal(connection.consecutiveFailures, 0)
  // Two backoff waits with half jitter: >= 250ms + 500ms.
  assert.ok(elapsed >= 700, `expected >=700ms of backoff, got ${elapsed}ms`)
})

test('transient failure on every attempt classifies provider-down after exactly 3 tries', async () => {
  let calls = 0
  const provider = fakeProvider(async () => {
    calls += 1
    throw errorWith({ message: 'fetch failed' })
  })
  const connection = connectionFor(provider)
  const result = await syncWithRetry({}, connection)
  assert.equal(calls, 3)
  assert.deepEqual(result, {
    connectionId: connection.id,
    ok: false,
    error: 'fetch failed',
    errorClass: 'provider-down',
    attempts: 3,
  })
  assert.equal(connection.consecutiveFailures, 1)
  assert.equal(connection.lastErrorClass, 'provider-down')
  assert.equal(connection.lastError, 'fetch failed')
})

test('permanent failure (auth) fails fast with a single attempt and accumulates failures', async () => {
  let calls = 0
  const provider = fakeProvider(async () => {
    calls += 1
    throw errorWith({ message: 'ITEM_LOGIN_REQUIRED', status: 401 })
  })
  const connection = connectionFor(provider)

  const first = await syncWithRetry({}, connection)
  assert.equal(calls, 1, 'auth errors must not be retried')
  assert.equal(first.ok, false)
  assert.equal(first.errorClass, 'auth')
  assert.equal(first.attempts, 1)
  assert.equal(connection.consecutiveFailures, 1)

  const second = await syncWithRetry({}, connection)
  assert.equal(calls, 2)
  assert.equal(second.errorClass, 'auth')
  assert.equal(connection.consecutiveFailures, 2, 'failures accumulate until a success or re-link')

  clearSyncFailures(connection)
  assert.equal(connection.consecutiveFailures, 0)
  assert.equal(connection.lastError, null)
  assert.equal(connection.lastErrorClass, null)
})

test('unknown errors fail fast (no retry) and stay visible as unknown', async () => {
  let calls = 0
  const provider = fakeProvider(async () => {
    calls += 1
    throw errorWith({ message: 'undefined is not a function' })
  })
  const connection = connectionFor(provider)
  const result = await syncWithRetry({}, connection)
  assert.equal(calls, 1)
  assert.equal(result.errorClass, 'unknown')
  assert.equal(result.attempts, 1)
})

test('a connection for an unregistered provider classifies as config without throwing', async () => {
  const connection = connectionFor('never-registered-provider')
  const result = await syncWithRetry({}, connection)
  assert.equal(result.ok, false)
  assert.equal(result.errorClass, 'config')
  assert.match(result.error, /unknown provider: never-registered-provider/)
  assert.equal(connection.consecutiveFailures, 1)
})

test('one failing provider never aborts another in the same sync pass', async () => {
  const downProvider = fakeProvider(async () => {
    throw errorWith({ message: 'ITEM_LOGIN_REQUIRED', status: 401 })
  })
  const okProvider = fakeProvider(async (db, connection) => ({ connectionId: connection.id, ok: true, added: 4 }))
  const failing = connectionFor(downProvider)
  const healthy = connectionFor(okProvider)

  // Mirror the /api/sync loop: sequential syncWithRetry over every target.
  const results = []
  for (const connection of [failing, healthy]) {
    results.push(await syncWithRetry({}, connection))
  }
  assert.equal(results.length, 2)
  assert.equal(results[0].ok, false)
  assert.equal(results[0].errorClass, 'auth')
  assert.equal(results[1].ok, true)
  assert.equal(results[1].added, 4)
  assert.equal(healthy.consecutiveFailures, 0)
})
