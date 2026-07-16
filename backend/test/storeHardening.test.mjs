// Store-level hardening: the listTransactions limit clamp (a negative LIMIT
// means "unbounded" to SQLite) and the additive insights inputTruncated
// signal for ledgers larger than the 5000-row detector input cap.
// Runs against a scratch SQLite file, never the real data DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfos-store-test-'))
process.env.PFOS_DATA_DIR = scratchDir
process.env.PFOS_DB_PATH = path.join(scratchDir, 'store-test.sqlite')
process.env.PFOS_MASTER_KEY = 'pfos-unit-test-master-key-0123456789'
process.env.PLAID_CLIENT_ID = ''
process.env.PLAID_SECRET = ''

const store = await import('../src/store.mjs')

function ledgerCount() {
  return store.readDb().transactions.length
}

test('listTransactions clamps hostile limits into [1, 5000]', () => {
  assert.ok(ledgerCount() > 1, 'demo seed must provide multiple transactions')
  // Negative would be an unbounded LIMIT in SQLite: clamp to 1.
  assert.equal(store.listTransactions(-1).length, 1)
  assert.equal(store.listTransactions(-9999).length, 1)
  // Non-numeric and zero fall back to the default of 100.
  assert.ok(store.listTransactions('abc').length <= 100)
  assert.ok(store.listTransactions(0).length <= 100)
  // Oversized asks cap at 5000 (cannot assert the cap bites on a small demo
  // ledger, but it must not throw and must return everything available).
  assert.equal(store.listTransactions(999999).length, Math.min(ledgerCount(), 5000))
})

test('insights payload carries inputTruncated: false while the ledger fits the cap', () => {
  const report = store.insightsReport()
  assert.equal(report.inputTruncated, false)
  // Contract fields stay present alongside the additive flag.
  for (const field of ['asOf', 'month', 'savings', 'forecast', 'anomalies', 'subscriptions']) {
    assert.ok(field in report, `insights payload must keep ${field}`)
  }
})

test('inputTruncated flips to true when the ledger outgrows the 5000-row detector input', () => {
  // Bulk rows are income (never anomaly/subscription candidates) with unique
  // merchants and old dates, so the detectors stay fast and the demo-derived
  // insight figures are not distorted — only the row count matters here.
  const needed = 5001 - ledgerCount()
  for (let i = 0; i < needed; i += 1) {
    store.upsertTransaction(null, {
      id: `bulk_test_${i}`,
      source: 'bulk_test',
      provider: 'manual',
      accountId: 'manual_checking_primary',
      date: '2019-01-01',
      merchant: `Bulk Filler ${i}`,
      description: null,
      amount: -1,
      currency: 'USD',
      category: 'Income',
      pending: false,
    })
  }
  assert.ok(ledgerCount() > 5000, 'ledger must now exceed the cap')
  const report = store.insightsReport()
  assert.equal(report.inputTruncated, true)
  // The memo key includes the row count, so the flag was recomputed, not stale.
  assert.equal(store.listTransactions(999999).length, 5000)
})
