// Provider registry: registration, lookup, unknown-provider handling, and the
// Plaid readiness check's not-configured path.
//
// Env is pinned BEFORE any src import: config.mjs reads process.env at module
// load and its .env loader only fills variables that are absent, so presetting
// PLAID_* to '' guarantees the "not configured" path even when backend/.env
// exists. The DB path points at a scratch file so nothing here can ever touch
// data/finance-os.sqlite (no test in this file opens the DB, but the registry
// import chain reaches store.mjs, which opens lazily).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfos-providers-test-'))
process.env.PFOS_DATA_DIR = scratchDir
process.env.PFOS_DB_PATH = path.join(scratchDir, 'providers-test.sqlite')
process.env.PFOS_MASTER_KEY = 'pfos-unit-test-master-key-0123456789'
process.env.PLAID_CLIENT_ID = ''
process.env.PLAID_SECRET = ''
process.env.PLAID_BASE_URL = ''

const { getProvider, listProviders, registerProvider } = await import('../src/providers/index.mjs')

function fakeAdapter(id) {
  return {
    id,
    label: `Fake ${id}`,
    linkMode: 'direct',
    isConfigured: () => true,
    createLinkToken: async () => ({ link_token: 'fake' }),
    exchangePublicToken: async () => ({ id: `conn_${id}` }),
    syncConnection: async () => ({ ok: true }),
    check: async () => ({ provider: id, configured: true, ok: true }),
  }
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

test('built-in providers resolve by id', () => {
  assert.equal(getProvider('plaid')?.id, 'plaid')
  assert.equal(getProvider('mock')?.id, 'mock')
})

test('unknown, empty, and non-string provider ids resolve to null', () => {
  assert.equal(getProvider('never-registered'), null)
  assert.equal(getProvider(''), null)
  assert.equal(getProvider(null), null)
  assert.equal(getProvider(undefined), null)
  assert.equal(getProvider(42), null)
})

test('listProviders exposes only the public shape (no adapter internals)', () => {
  const providers = listProviders()
  const plaid = providers.find((p) => p.id === 'plaid')
  const mock = providers.find((p) => p.id === 'mock')
  assert.ok(plaid && mock, 'plaid and mock must both be registered')
  for (const entry of providers) {
    assert.deepEqual(Object.keys(entry).sort(), ['configured', 'id', 'label', 'linkMode'])
    assert.equal(typeof entry.configured, 'boolean')
  }
  assert.equal(plaid.linkMode, 'sdk')
  assert.equal(mock.linkMode, 'direct')
  assert.equal(mock.configured, true)
})

// ---------------------------------------------------------------------------
// Plaid readiness check — not-configured path (no credentials in this process)
// ---------------------------------------------------------------------------

test('plaid reports not configured when PLAID_CLIENT_ID/SECRET are absent', () => {
  assert.equal(getProvider('plaid').isConfigured(), false)
  const listed = listProviders().find((p) => p.id === 'plaid')
  assert.equal(listed.configured, false)
})

test('plaid check() returns a structured failure without throwing or fetching', async () => {
  const result = await getProvider('plaid').check()
  assert.deepEqual(result, {
    provider: 'plaid',
    configured: false,
    ok: false,
    error: 'not configured',
    message: 'Set PLAID_CLIENT_ID and PLAID_SECRET in backend/.env.',
  })
})

test('mock check() is always ready with no credentials', async () => {
  const result = await getProvider('mock').check()
  assert.equal(result.provider, 'mock')
  assert.equal(result.configured, true)
  assert.equal(result.ok, true)
})

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

test('registerProvider makes a new adapter resolvable and listed', () => {
  const adapter = fakeAdapter('fake-bank')
  assert.equal(registerProvider(adapter), adapter)
  assert.equal(getProvider('fake-bank'), adapter)
  const listed = listProviders().find((p) => p.id === 'fake-bank')
  assert.deepEqual(listed, { id: 'fake-bank', label: 'Fake fake-bank', configured: true, linkMode: 'direct' })
})

test('duplicate registration is refused (built-ins cannot be replaced)', () => {
  assert.throws(() => registerProvider(fakeAdapter('plaid')), /already registered: plaid/)
  assert.throws(() => registerProvider(fakeAdapter('mock')), /already registered: mock/)
  registerProvider(fakeAdapter('fake-dup'))
  assert.throws(() => registerProvider(fakeAdapter('fake-dup')), /already registered: fake-dup/)
})

test('malformed adapters are refused with a specific error', () => {
  assert.throws(() => registerProvider(null), /adapter object is required/)
  assert.throws(() => registerProvider({}), /provider\.id is required/)
  const missingSync = fakeAdapter('fake-broken')
  delete missingSync.syncConnection
  assert.throws(() => registerProvider(missingSync), /provider\.syncConnection must be a function/)
  // A refused registration must not be partially applied.
  assert.equal(getProvider('fake-broken'), null)
})
