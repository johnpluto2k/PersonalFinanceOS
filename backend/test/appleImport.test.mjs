// Apple Card CSV import: parser correctness (real export headers, quoting,
// dates, amounts), malformed-row tolerance, and end-to-end dedup through the
// store (same CSV imported twice adds zero new rows; near-duplicates do not
// collapse). Uses a scratch SQLite file, never the real data DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfos-apple-import-test-'))
process.env.PFOS_DATA_DIR = scratchDir
process.env.PFOS_DB_PATH = path.join(scratchDir, 'apple-import-test.sqlite')
process.env.PFOS_MASTER_KEY = 'pfos-unit-test-master-key-0123456789'
process.env.PLAID_CLIENT_ID = ''
process.env.PLAID_SECRET = ''

const { parseAppleCardCsv } = await import('../src/appleCardImport.mjs')
const store = await import('../src/store.mjs')

// The exact column titles a real Wallet / card.apple.com export uses —
// including "Amount (USD)", which must be recognized.
const APPLE_HEADER = 'Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By'

function csvOf(...rows) {
  return [APPLE_HEADER, ...rows].join('\n')
}

function importedRows() {
  return store.readDb().transactions.filter((t) => t.source === 'apple_card_csv')
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

test('real Apple export headers parse: dates, merchant, and Amount (USD)', () => {
  const txs = parseAppleCardCsv(csvOf(
    '07/04/2026,07/05/2026,NETFLIX.COM 866-579-7172 CA,Netflix,Other,Purchase,17.49,John Bae',
    '07/03/2026,07/03/2026,ACH DEPOSIT INTERNET TRANSFER,Apple Card Payment,Payment,Payment,-75.00,John Bae',
  ))
  assert.equal(txs.length, 2)
  assert.equal(txs[0].date, '2026-07-04')
  assert.equal(txs[0].merchant, 'NETFLIX.COM 866-579-7172 CA')
  assert.equal(txs[0].amount, 17.49)
  assert.equal(txs[0].accountId, 'apple_card_manual')
  assert.equal(txs[0].provider, 'apple')
  assert.match(txs[0].id, /^apple_[0-9a-f]{40}$/)
  assert.equal(txs[1].amount, -75)
})

test('quoted fields: embedded commas and escaped quotes survive intact', () => {
  const txs = parseAppleCardCsv(csvOf(
    '07/06/2026,07/07/2026,"Joe\'s ""Best"" Diner, Downtown",Joes,Restaurants,Purchase,32.50,John Bae',
  ))
  assert.equal(txs.length, 1)
  assert.equal(txs[0].merchant, 'Joe\'s "Best" Diner, Downtown')
  assert.equal(txs[0].amount, 32.5)
})

test('amount formats: currency symbols, thousands separators, paren negatives', () => {
  const txs = parseAppleCardCsv(csvOf(
    '07/01/2026,07/01/2026,Big Purchase,Store,Shopping,Purchase,"$1,234.56",John Bae',
    '07/02/2026,07/02/2026,Refund,Store,Shopping,Refund,(45.00),John Bae',
  ))
  assert.equal(txs[0].amount, 1234.56)
  assert.equal(txs[1].amount, -45)
})

test('ISO dates pass through; BOM is stripped', () => {
  // NOTE: the template literal below starts with a real (invisible) U+FEFF
  // byte-order mark, exactly as Excel-saved CSV exports carry it.
  const txs = parseAppleCardCsv(`﻿${csvOf('2026-07-04,2026-07-05,Coffee,Cafe,Restaurants,Purchase,4.50,John Bae')}`)
  assert.equal(txs.length, 1)
  assert.equal(txs[0].date, '2026-07-04')
})

test('formula-injection characters are stored as inert data, not stripped', () => {
  const txs = parseAppleCardCsv(csvOf(
    '07/08/2026,07/08/2026,"=cmd|\'/c calc\'!A0",EvilCo,Shopping,Purchase,9.99,John Bae',
  ))
  assert.equal(txs.length, 1)
  assert.equal(txs[0].merchant, "=cmd|'/c calc'!A0")
})

test('malformed rows are skipped without aborting the rest of the import', () => {
  const txs = parseAppleCardCsv(csvOf(
    '07/04/2026,07/05/2026,Good Row,Store,Shopping,Purchase,10.00,John Bae',
    'Total,,,,,,,', //                    summary line: no date, no amount
    ',,,,,,,', //                         empty separator row
    'garbage-single-cell', //             truncated row
    '07/05/2026,07/05/2026,Second Good Row,Store,Shopping,Purchase,11.00,John Bae',
  ))
  assert.equal(txs.length, 2)
  assert.deepEqual(txs.map((t) => t.merchant), ['Good Row', 'Second Good Row'])
})

test('empty text, header-only, and blank-line-only inputs yield no transactions', () => {
  assert.deepEqual(parseAppleCardCsv(''), [])
  assert.deepEqual(parseAppleCardCsv(null), [])
  assert.deepEqual(parseAppleCardCsv(APPLE_HEADER), [])
  assert.deepEqual(parseAppleCardCsv(`${APPLE_HEADER}\n\n\n`), [])
})

test('ids are deterministic: parsing the same CSV twice yields identical ids', () => {
  const csv = csvOf(
    '07/04/2026,07/05/2026,Coffee,Cafe,Restaurants,Purchase,4.50,John Bae',
    '07/04/2026,07/05/2026,Lunch,Deli,Restaurants,Purchase,12.25,John Bae',
  )
  const first = parseAppleCardCsv(csv).map((t) => t.id)
  const second = parseAppleCardCsv(csv).map((t) => t.id)
  assert.deepEqual(first, second)
})

test('near-duplicates (same date+amount, different merchant) get distinct ids', () => {
  const txs = parseAppleCardCsv(csvOf(
    '07/10/2026,07/10/2026,Coffee Shop A,CoffeeA,Restaurants,Purchase,4.50,John Bae',
    '07/10/2026,07/10/2026,Coffee Shop B,CoffeeB,Restaurants,Purchase,4.50,John Bae',
  ))
  assert.equal(txs.length, 2)
  assert.notEqual(txs[0].id, txs[1].id)
})

// ---------------------------------------------------------------------------
// dedup through the store (the /api/import/apple-card persistence path)
// ---------------------------------------------------------------------------

const IMPORT_CSV = csvOf(
  '06/01/2026,06/02/2026,Grocery Run,Market,Grocery,Purchase,84.12,John Bae',
  '06/03/2026,06/04/2026,Streaming,StreamCo,Entertainment,Purchase,15.49,John Bae',
  '06/03/2026,06/04/2026,Streaming Two,OtherStream,Entertainment,Purchase,15.49,John Bae', // near-duplicate of the row above
  '06/05/2026,06/05/2026,Card Payment,Payment,Payment,Payment,-200.00,John Bae',
)

function importCsv(csv) {
  const txs = parseAppleCardCsv(csv)
  for (const tx of txs) store.upsertTransaction(null, tx)
  return txs
}

test('first import persists every parsed row, including near-duplicates', () => {
  assert.equal(importedRows().length, 0, 'scratch DB must start with no CSV imports')
  const txs = importCsv(IMPORT_CSV)
  assert.equal(txs.length, 4)
  const rows = importedRows()
  assert.equal(rows.length, 4)
  // The two same-date same-amount rows must both survive as separate rows.
  const nearDupes = rows.filter((r) => r.amount === 15.49)
  assert.equal(nearDupes.length, 2)
  assert.deepEqual(new Set(nearDupes.map((r) => r.merchant)), new Set(['Streaming', 'Streaming Two']))
})

test('importing the same CSV again adds zero new rows', () => {
  const before = importedRows()
  importCsv(IMPORT_CSV)
  const after = importedRows()
  assert.equal(after.length, before.length, 're-import must be a pure upsert (no new rows)')
  assert.deepEqual(
    new Set(after.map((r) => r.id)),
    new Set(before.map((r) => r.id)),
  )
})

test('an exact duplicate line within one CSV collapses to a single stored row', () => {
  const dupeCsv = csvOf(
    '06/10/2026,06/10/2026,Twice Charged,Store,Shopping,Purchase,20.00,John Bae',
    '06/10/2026,06/10/2026,Twice Charged,Store,Shopping,Purchase,20.00,John Bae',
  )
  const parsed = importCsv(dupeCsv)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].id, parsed[1].id)
  const stored = importedRows().filter((r) => r.merchant === 'Twice Charged')
  assert.equal(stored.length, 1)
})
