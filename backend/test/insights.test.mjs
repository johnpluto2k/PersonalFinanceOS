import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeForecast,
  computeSavingsRates,
  detectAnomalies,
  detectSubscriptionsV2,
} from '../src/insights.mjs'

let txSeq = 0
function tx(date, merchant, amount, overrides = {}) {
  txSeq += 1
  return {
    id: overrides.id || `tx_${txSeq}`,
    date,
    merchant,
    description: overrides.description || null,
    amount,
    category: overrides.category ?? 'Uncategorized',
    accountId: overrides.accountId ?? 'acct_1',
    pending: overrides.pending ?? false,
  }
}

// Monthly charges on the same day-of-month across consecutive months.
function monthlySeries(merchant, amounts, { startMonth = '2026-01', day = '12', ...overrides } = {}) {
  return amounts.map((amount, i) => {
    const month = 1 + i
    return tx(`2026-${String(startMonth.slice(5) * 1 + i).padStart(2, '0')}-${day}`, merchant, amount, overrides)
  })
}

// ---------------------------------------------------------------------------
// detectSubscriptionsV2
// ---------------------------------------------------------------------------

test('flat monthly series: detected as monthly, no price increase', () => {
  const txs = monthlySeries('Spotify', [10.99, 10.99, 10.99, 10.99, 10.99, 10.99], { category: 'Subscriptions' })
  const [sub, ...rest] = detectSubscriptionsV2(txs, { asOf: '2026-06-30' })
  assert.equal(rest.length, 0)
  assert.equal(sub.merchant, 'Spotify')
  assert.equal(sub.cadence, 'monthly')
  assert.equal(sub.monthlyCost, 10.99)
  assert.equal(sub.medianAmount, 10.99)
  assert.equal(sub.chargeCount, 6)
  assert.equal(sub.lastCharged, '2026-06-12')
  assert.equal(sub.nextExpectedDate, '2026-07-12')
  assert.equal(sub.priceIncrease, null)
  assert.equal(sub.intervalConformity, 1)
  assert.equal(sub.amountConformity, 1)
  // Subscriptions category + both conformity bonuses, capped: 0.5+0.2+0.15+0.15 -> 0.98
  assert.equal(sub.confidence, 0.98)
  assert.equal(sub.seriesKey, 'spotify|acct_1')
})

test('mild drift within tolerance stays a single run (no price increase)', () => {
  // Drift spans +/- $1.50 around $15 but every charge stays within the $2.00
  // tolerance of the evolving run median -> one run, no increase.
  const txs = monthlySeries('Gym', [15.0, 16.0, 14.5, 15.5, 15.0, 16.0], { category: 'Health' })
  const [sub] = detectSubscriptionsV2(txs, { asOf: '2026-06-30' })
  assert.ok(sub, 'series should be detected')
  assert.equal(sub.priceIncrease, null)
  assert.equal(sub.cadence, 'monthly')
})

test('Netflix +$2.00 bump: exact delta, effectiveDate, confirmedCharges', () => {
  const txs = monthlySeries('Netflix', [15.49, 15.49, 15.49, 15.49, 15.49, 17.49, 17.49], { category: 'Subscriptions' })
  const [sub] = detectSubscriptionsV2(txs, { asOf: '2026-07-15' })
  assert.ok(sub.priceIncrease, 'price increase must be detected')
  assert.equal(sub.priceIncrease.previousAmount, 15.49)
  assert.equal(sub.priceIncrease.newAmount, 17.49)
  assert.equal(sub.priceIncrease.delta, 2.0)
  assert.equal(sub.priceIncrease.percent, 12.9)
  assert.equal(sub.priceIncrease.effectiveDate, '2026-06-12')
  assert.equal(sub.priceIncrease.confirmedCharges, 2)
  // medianAmount stays the whole-series median (15.49); monthlyCost follows it.
  assert.equal(sub.medianAmount, 15.49)
})

test('annual series with two charges: cadence annual, monthlyCost /12', () => {
  const txs = [
    tx('2025-03-10', 'Domain Registrar', 120, { category: 'Shopping' }),
    tx('2026-03-10', 'Domain Registrar', 120, { category: 'Shopping' }),
  ]
  const [sub] = detectSubscriptionsV2(txs, { asOf: '2026-07-15' })
  assert.ok(sub, 'annual series with 2 charges should be detected')
  assert.equal(sub.cadence, 'annual')
  assert.equal(sub.monthlyCost, 10)
  assert.equal(sub.nextExpectedDate, '2027-03-10')
})

test('irregular gas station spending is rejected', () => {
  const txs = [
    tx('2026-01-03', 'Gas Station', 38.2, { category: 'Transport' }),
    tx('2026-01-19', 'Gas Station', 51.7, { category: 'Transport' }),
    tx('2026-02-02', 'Gas Station', 29.9, { category: 'Transport' }),
    tx('2026-03-27', 'Gas Station', 44.0, { category: 'Transport' }),
    tx('2026-04-04', 'Gas Station', 61.3, { category: 'Transport' }),
    tx('2026-05-30', 'Gas Station', 35.5, { category: 'Transport' }),
  ]
  assert.deepEqual(detectSubscriptionsV2(txs, { asOf: '2026-06-30' }), [])
})

test('Subscriptions category is always listed even when checks reject it', () => {
  // Two irregular charges: too few for monthly cadence, but category wins.
  const txs = [
    tx('2026-02-01', 'Weird SaaS', 9, { category: 'Subscriptions' }),
    tx('2026-02-20', 'Weird SaaS', 30, { category: 'Subscriptions' }),
  ]
  const [sub] = detectSubscriptionsV2(txs, { asOf: '2026-07-15' })
  assert.ok(sub, 'Subscriptions-category series must always be listed')
  assert.equal(sub.cadence, 'monthly') // best-effort default
})

test('subscription grouping is per (merchant, account): two rows for two cards', () => {
  const a = monthlySeries('Netflix', [15.49, 15.49, 15.49, 15.49], { category: 'Subscriptions', accountId: 'card_a' })
  const b = monthlySeries('Netflix', [15.49, 15.49, 15.49, 15.49], { category: 'Subscriptions', accountId: 'card_b', day: '05' })
  const subs = detectSubscriptionsV2([...a, ...b], { asOf: '2026-05-01' })
  assert.equal(subs.length, 2)
  assert.deepEqual(new Set(subs.map((s) => s.accountId)), new Set(['card_a', 'card_b']))
})

test('pending and Transfer transactions are excluded from series', () => {
  const txs = [
    ...monthlySeries('Brokerage Transfer', [500, 500, 500, 500], { category: 'Transfer' }),
    ...monthlySeries('Maybe TV', [12, 12, 12, 12], { category: 'Subscriptions', pending: true }),
  ]
  assert.deepEqual(detectSubscriptionsV2(txs, { asOf: '2026-05-01' }), [])
})

// ---------------------------------------------------------------------------
// detectAnomalies
// ---------------------------------------------------------------------------

test('zero-MAD rent series: doubled rent flags at medium severity', () => {
  const rents = monthlySeries('Rent', Array(12).fill(980), { category: 'Housing', day: '01' })
  // 12 identical charges Jan-Dec 2026... build a 13th, doubled, inside the window.
  const doubled = tx('2026-12-28', 'Rent', 1960, { category: 'Housing' })
  const anomalies = detectAnomalies([...rents, doubled], { asOf: '2026-12-31' })
  assert.equal(anomalies.length, 1)
  const [a] = anomalies
  assert.equal(a.transactionId, doubled.id)
  assert.equal(a.baseline.basis, 'merchant')
  assert.equal(a.baseline.median, 980)
  assert.equal(a.baseline.mad, 0) // zero-variance series
  // sigma = max(1.4826*0, 0.15*980, 1.00) = 147 -> z = 980/147
  assert.equal(a.robustZ, 6.67)
  assert.equal(a.multiple, 2)
  // 1960 >= 2x980 but < 3x980 -> medium
  assert.equal(a.severity, 'medium')
  // The 12 normal rents must NOT flag.
  assert.ok(!anomalies.some((x) => x.transactionId !== doubled.id))
})

test('normal charges in-window do not flag (all three conditions required)', () => {
  const rents = monthlySeries('Rent', Array(12).fill(980), { category: 'Housing', day: '01' })
  // 1100 has robustZ = 120/147 = 0.8 -> below 3.5; also fails 2x median.
  const slightlyHigh = tx('2026-12-28', 'Rent', 1100, { category: 'Housing' })
  assert.deepEqual(detectAnomalies([...rents, slightlyHigh], { asOf: '2026-12-31' }), [])
})

test('merchant fallback to category peers when merchant history is thin', () => {
  // Only 2 prior charges at this merchant (<5) but 14 same-category peers.
  const diningPeers = []
  for (let i = 0; i < 14; i += 1) {
    diningPeers.push(tx(`2026-0${(i % 6) + 1}-1${i % 9}`, `Cafe ${i}`, 12 + (i % 5), { category: 'Dining' }))
  }
  const thinMerchant = [
    tx('2026-05-02', 'Chipotle', 14, { category: 'Dining' }),
    tx('2026-06-02', 'Chipotle', 15, { category: 'Dining' }),
  ]
  const spike = tx('2026-07-05', 'Chipotle', 180, { category: 'Dining' })
  const anomalies = detectAnomalies([...diningPeers, ...thinMerchant, spike], { asOf: '2026-07-15' })
  assert.equal(anomalies.length, 1)
  assert.equal(anomalies[0].baseline.basis, 'category')
  assert.equal(anomalies[0].severity, 'high')
  assert.ok(anomalies[0].baseline.sampleSize >= 12)
})

test('skip when both merchant (<5) and category (<12) peers are thin', () => {
  const txs = [
    tx('2026-06-01', 'Rare Shop', 10, { category: 'Shopping' }),
    tx('2026-06-15', 'Rare Shop', 11, { category: 'Shopping' }),
    tx('2026-07-01', 'Rare Shop', 400, { category: 'Shopping' }),
  ]
  assert.deepEqual(detectAnomalies(txs, { asOf: '2026-07-15' }), [])
})

test('anomaly window: transactions older than recentDays are not candidates', () => {
  const rents = monthlySeries('Rent', Array(12).fill(980), { category: 'Housing', day: '01' })
  const oldSpike = tx('2026-06-15', 'Rent', 5000, { category: 'Housing' })
  const anomalies = detectAnomalies([...rents, oldSpike], { asOf: '2026-12-31', recentDays: 60 })
  assert.deepEqual(anomalies, [])
})

test('empty ledger yields no anomalies and no subscriptions', () => {
  assert.deepEqual(detectAnomalies([], { asOf: '2026-07-15' }), [])
  assert.deepEqual(detectSubscriptionsV2([], { asOf: '2026-07-15' }), [])
})

// ---------------------------------------------------------------------------
// computeForecast
// ---------------------------------------------------------------------------

test('forecast: catch-up-to-baseline arithmetic', () => {
  const cashflow = [
    { month: '2026-07', income: 5590.3, spending: 4291.93 },
    { month: '2026-06', income: 6400, spending: 4500 },
    { month: '2026-05', income: 6400, spending: 4500 },
    { month: '2026-04', income: 6402.49, spending: 4476.24 },
  ]
  const f = computeForecast({ cashNow: 31900.19, monthlyCashflow: cashflow, asOf: '2026-07-15' })
  assert.equal(f.month, '2026-07')
  assert.equal(f.daysElapsed, 15)
  assert.equal(f.daysInMonth, 31)
  assert.deepEqual(f.baselineMonths, ['2026-04', '2026-05', '2026-06'])
  assert.equal(f.avgIncome, 6400.83)
  assert.equal(f.avgSpend, 4492.08)
  assert.equal(f.incomeMtd, 5590.3)
  assert.equal(f.spendMtd, 4291.93)
  assert.equal(f.projectedIncome, 6400.83) // behind baseline -> catch up
  assert.equal(f.projectedSpending, 4492.08)
  // 31900.19 + (6400.83 - 5590.30) - (4492.08 - 4291.93) = 32510.57
  assert.equal(f.projectedEndOfMonthCash, 32510.57)
  assert.equal(f.projectedNet, 1908.75)
})

test('forecast: actuals already past baseline are kept (max, not average)', () => {
  const cashflow = [
    { month: '2026-07', income: 9000, spending: 5000 },
    { month: '2026-06', income: 6000, spending: 4000 },
    { month: '2026-05', income: 6000, spending: 4000 },
    { month: '2026-04', income: 6000, spending: 4000 },
  ]
  const f = computeForecast({ cashNow: 1000, monthlyCashflow: cashflow, asOf: '2026-07-20' })
  assert.equal(f.projectedIncome, 9000)
  assert.equal(f.projectedSpending, 5000)
  assert.equal(f.projectedEndOfMonthCash, 1000) // nothing left to catch up
})

test('forecast: empty cashflow projects cashNow unchanged', () => {
  const f = computeForecast({ cashNow: 250.5, monthlyCashflow: [], asOf: '2026-07-15' })
  assert.equal(f.avgIncome, 0)
  assert.equal(f.avgSpend, 0)
  assert.equal(f.projectedEndOfMonthCash, 250.5)
})

// ---------------------------------------------------------------------------
// computeSavingsRates
// ---------------------------------------------------------------------------

test('savings rates over complete months exclude the partial current month', () => {
  const cashflow = [
    { month: '2026-07', income: 100, spending: 100000 }, // partial month must be ignored
    { month: '2026-06', income: 6000, spending: 4200 },
    { month: '2026-05', income: 6000, spending: 4200 },
    { month: '2026-04', income: 6000, spending: 4200 },
    { month: '2026-03', income: 5000, spending: 5000 },
    { month: '2026-02', income: 5000, spending: 5000 },
    { month: '2026-01', income: 5000, spending: 5000 },
  ]
  const s = computeSavingsRates(cashflow, '2026-07')
  assert.deepEqual(s.threeMonth.months, ['2026-04', '2026-05', '2026-06'])
  assert.equal(s.threeMonth.income, 18000)
  assert.equal(s.threeMonth.spending, 12600)
  assert.equal(s.threeMonth.rate, 0.3) // (18000-12600)/18000
  assert.deepEqual(s.sixMonth.months, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'])
  assert.equal(s.sixMonth.rate, Math.round(((33000 - 27600) / 33000) * 10000) / 10000)
})

test('savings rate is null when window income is zero', () => {
  const s = computeSavingsRates([{ month: '2026-06', income: 0, spending: 500 }], '2026-07')
  assert.equal(s.threeMonth.rate, null)
  assert.equal(s.sixMonth.rate, null)
})

test('savings rates on an empty cashflow are null with zero totals', () => {
  const s = computeSavingsRates([], '2026-07')
  assert.equal(s.threeMonth.rate, null)
  assert.equal(s.threeMonth.income, 0)
  assert.equal(s.sixMonth.rate, null)
})
