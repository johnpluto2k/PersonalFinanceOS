import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addMonthsText,
  computeForecast,
  computeSavingsRates,
  detectAnomalies,
  detectSubscriptionsV2,
  monthlyCashflowFromTransactions,
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

// Monthly charges on the same day-of-month across consecutive months, starting
// at startMonth ('YYYY-MM'). Uses real month arithmetic so any start month —
// including series that cross a year boundary — yields valid dates.
function monthlySeries(merchant, amounts, { startMonth = '2026-01', day = '12', ...overrides } = {}) {
  return amounts.map((amount, i) => tx(`${addMonthsText(startMonth, i)}-${day}`, merchant, amount, overrides))
}

// ---------------------------------------------------------------------------
// detectSubscriptionsV2
// ---------------------------------------------------------------------------

test('flat monthly series: detected as monthly, no price increase', () => {
  const txs = monthlySeries('Spotify', [10.99, 10.99, 10.99, 10.99, 10.99, 10.99], { category: 'Subscriptions' })
  const [sub, ...rest] = detectSubscriptionsV2(txs)
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
  const [sub] = detectSubscriptionsV2(txs)
  assert.ok(sub, 'series should be detected')
  assert.equal(sub.priceIncrease, null)
  assert.equal(sub.cadence, 'monthly')
})

test('Netflix +$2.00 bump: exact delta, effectiveDate, confirmedCharges', () => {
  const txs = monthlySeries('Netflix', [15.49, 15.49, 15.49, 15.49, 15.49, 17.49, 17.49], { category: 'Subscriptions' })
  const [sub] = detectSubscriptionsV2(txs)
  assert.ok(sub.priceIncrease, 'price increase must be detected')
  assert.equal(sub.priceIncrease.previousAmount, 15.49)
  assert.equal(sub.priceIncrease.newAmount, 17.49)
  assert.equal(sub.priceIncrease.delta, 2.0)
  assert.equal(sub.priceIncrease.percent, 12.9)
  assert.equal(sub.priceIncrease.effectiveDate, '2026-06-12')
  assert.equal(sub.priceIncrease.confirmedCharges, 2)
  // medianAmount stays the whole-series median (15.49); the headline
  // monthlyCost reflects the CURRENT price — the last run's median.
  assert.equal(sub.medianAmount, 15.49)
  assert.equal(sub.monthlyCost, 17.49)
})

test('annual series with two charges: cadence annual, monthlyCost /12', () => {
  const txs = [
    tx('2025-03-10', 'Domain Registrar', 120, { category: 'Shopping' }),
    tx('2026-03-10', 'Domain Registrar', 120, { category: 'Shopping' }),
  ]
  const [sub] = detectSubscriptionsV2(txs)
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
  assert.deepEqual(detectSubscriptionsV2(txs), [])
})

test('Subscriptions category is always listed even when checks reject it', () => {
  // Two irregular charges: too few for monthly cadence, but category wins.
  const txs = [
    tx('2026-02-01', 'Weird SaaS', 9, { category: 'Subscriptions' }),
    tx('2026-02-20', 'Weird SaaS', 30, { category: 'Subscriptions' }),
  ]
  const [sub] = detectSubscriptionsV2(txs)
  assert.ok(sub, 'Subscriptions-category series must always be listed')
  assert.equal(sub.cadence, 'monthly') // best-effort default
})

test('subscription grouping is per (merchant, account): two rows for two cards', () => {
  const a = monthlySeries('Netflix', [15.49, 15.49, 15.49, 15.49], { category: 'Subscriptions', accountId: 'card_a' })
  const b = monthlySeries('Netflix', [15.49, 15.49, 15.49, 15.49], { category: 'Subscriptions', accountId: 'card_b', day: '05' })
  const subs = detectSubscriptionsV2([...a, ...b])
  assert.equal(subs.length, 2)
  assert.deepEqual(new Set(subs.map((s) => s.accountId)), new Set(['card_a', 'card_b']))
})

test('pending and Transfer transactions are excluded from series', () => {
  const txs = [
    ...monthlySeries('Brokerage Transfer', [500, 500, 500, 500], { category: 'Transfer' }),
    ...monthlySeries('Maybe TV', [12, 12, 12, 12], { category: 'Subscriptions', pending: true }),
  ]
  assert.deepEqual(detectSubscriptionsV2(txs), [])
})

test('monthlySeries fixture crosses year boundaries with valid dates', () => {
  // Regression: the old fixture hardcoded year 2026 and produced invalid
  // month numbers for non-default startMonth values.
  const txs = monthlySeries('Hulu', [11.99, 11.99, 11.99, 11.99, 11.99, 11.99], { startMonth: '2025-10', category: 'Subscriptions' })
  assert.deepEqual(txs.map((t) => t.date), [
    '2025-10-12', '2025-11-12', '2025-12-12', '2026-01-12', '2026-02-12', '2026-03-12',
  ])
  const [sub] = detectSubscriptionsV2(txs)
  assert.equal(sub.cadence, 'monthly')
  assert.equal(sub.lastCharged, '2026-03-12')
})

test('category and Subscriptions exception key off the NEWEST charge', () => {
  // Two irregular charges; only the newest is categorized 'Subscriptions'.
  // v1 semantics: the series is judged by its current (newest) category, so
  // the always-list exception applies and the row reports it.
  const txs = [
    tx('2026-02-01', 'Recategorized SaaS', 12, { category: 'Shopping' }),
    tx('2026-02-20', 'Recategorized SaaS', 12, { category: 'Subscriptions' }),
  ]
  const [sub, ...rest] = detectSubscriptionsV2(txs)
  assert.equal(rest.length, 0)
  assert.ok(sub, 'newest-charge Subscriptions category must trigger the exception')
  assert.equal(sub.category, 'Subscriptions')
})

test('per-run conformity accepts a clean price-increase series (internet bill)', () => {
  // 6 x $9.99 then 4 x $12.99: the old whole-series-median conformity scored
  // 6/10 = 0.6 < 0.7 and rejected exactly the series the detector targets.
  // Per-run: two stable runs cover 100% of charges.
  const txs = monthlySeries('City Internet', [9.99, 9.99, 9.99, 9.99, 9.99, 9.99, 12.99, 12.99, 12.99, 12.99], { startMonth: '2025-10', category: 'Utilities' })
  const [sub] = detectSubscriptionsV2(txs)
  assert.ok(sub, 'price-increase series must be detected')
  assert.equal(sub.amountConformity, 1)
  assert.ok(sub.priceIncrease)
  assert.equal(sub.priceIncrease.previousAmount, 9.99)
  assert.equal(sub.priceIncrease.newAmount, 12.99)
  assert.equal(sub.priceIncrease.delta, 3)
  assert.equal(sub.monthlyCost, 12.99) // current price, not the 9.99 all-time median
})

test('per-run conformity: creeping drift with no stable runs stays rejected', () => {
  // Monthly cadence but every charge starts its own run (steps larger than the
  // tolerance): shopping/grocery drift like the demo Amazon series.
  const amazon = monthlySeries('Amazon', [74, 80, 86, 92, 98, 104, 110], { category: 'Shopping' })
  assert.deepEqual(detectSubscriptionsV2(amazon), [])
  const costco = monthlySeries('Costco', [182.14, 95.6, 261.9, 143.05, 208.3, 121.75], { category: 'Groceries' })
  assert.deepEqual(detectSubscriptionsV2(costco), [])
  const safeway = monthlySeries('Safeway', [82.14, 45.6, 121.9, 63.05, 98.3, 71.75], { category: 'Groceries' })
  assert.deepEqual(detectSubscriptionsV2(safeway), [])
})

test('per-run conformity: 4+3 stepped runs stay accepted with their increase', () => {
  // Demo City Utilities shape: +$3/month creeps within tolerance until the
  // cumulative step splits the runs at 4 + 3 charges.
  const utilities = monthlySeries('City Utilities', [118, 121, 124, 127, 130, 133, 136], { category: 'Utilities' })
  const [util] = detectSubscriptionsV2(utilities)
  assert.ok(util, 'City Utilities must stay accepted')
  assert.equal(util.amountConformity, 1)
  assert.ok(util.priceIncrease)
  assert.equal(util.priceIncrease.previousAmount, 122.5) // median of 118..127
  assert.equal(util.priceIncrease.newAmount, 133) // median of 130,133,136
  // Demo Whole Foods shape: +$2/month, also 4 + 3 runs.
  const wholeFoods = monthlySeries('Whole Foods', [88, 90, 92, 94, 96, 98, 100], { category: 'Groceries' })
  const [wf] = detectSubscriptionsV2(wholeFoods)
  assert.ok(wf, 'Whole Foods must stay accepted')
  assert.ok(wf.priceIncrease)
  assert.equal(wf.priceIncrease.previousAmount, 91)
  assert.equal(wf.priceIncrease.newAmount, 98)
})

test('promo guard: a single discounted month does not fabricate an increase', () => {
  // $10.99 x 4, one $5.99 promo month, then $10.99 x 3. The comparison run is
  // the nearest PRECEDING run of length >= 2 (skipping the promo singleton),
  // so the delta is $0.00 — not a fake "+$5.00".
  const txs = monthlySeries('Streaming+', [10.99, 10.99, 10.99, 10.99, 5.99, 10.99, 10.99, 10.99], { startMonth: '2025-11', category: 'Subscriptions' })
  const [sub] = detectSubscriptionsV2(txs)
  assert.ok(sub, 'series must still be detected')
  assert.equal(sub.priceIncrease, null)
})

test('promo guard: real increase after a promo month is still measured against the stable run', () => {
  const txs = monthlySeries('Streaming+', [10.99, 10.99, 10.99, 10.99, 5.99, 12.99, 12.99, 12.99], { startMonth: '2025-11', category: 'Subscriptions' })
  const [sub] = detectSubscriptionsV2(txs)
  assert.ok(sub.priceIncrease)
  assert.equal(sub.priceIncrease.previousAmount, 10.99)
  assert.equal(sub.priceIncrease.newAmount, 12.99)
  assert.equal(sub.priceIncrease.delta, 2)
})

test('promo guard: a single charge at a new price is not yet a confirmed increase', () => {
  const txs = monthlySeries('Netflix', [15.49, 15.49, 15.49, 15.49, 15.49, 17.49], { category: 'Subscriptions' })
  const [sub] = detectSubscriptionsV2(txs)
  assert.ok(sub, 'series must still be detected')
  assert.equal(sub.priceIncrease, null) // last run has only 1 charge
})

test('weekly monthlyCost derives from the last run at x52/12', () => {
  const dates = []
  for (let i = 0; i < 10; i += 1) dates.push(i)
  const txs = dates.map((i) => {
    const date = new Date(Date.UTC(2026, 3, 6 + i * 7)).toISOString().slice(0, 10)
    return tx(date, 'Meal Kit', i < 6 ? 20 : 25, { category: 'Subscriptions' })
  })
  const [sub] = detectSubscriptionsV2(txs)
  assert.equal(sub.cadence, 'weekly')
  assert.equal(sub.monthlyCost, Math.round(25 * (52 / 12) * 100) / 100) // 108.33 from the current $25 run
  assert.ok(sub.priceIncrease)
  assert.equal(sub.priceIncrease.previousAmount, 20)
  assert.equal(sub.priceIncrease.newAmount, 25)
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
  assert.deepEqual(detectSubscriptionsV2([]), [])
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

// ---------------------------------------------------------------------------
// monthlyCashflowFromTransactions (pending-consistent buckets for forecast/savings)
// ---------------------------------------------------------------------------

test('monthly buckets exclude pending and Transfer transactions', () => {
  const txs = [
    tx('2026-06-01', 'Paycheck', -3000, { category: 'Income' }),
    tx('2026-06-05', 'Rent', 980, { category: 'Housing' }),
    tx('2026-06-07', 'Card Autopay', 500, { category: 'Transfer' }), // excluded
    tx('2026-06-08', 'Pending Store', 250, { pending: true }), // excluded
    tx('2026-06-09', 'Pending Refund', -40, { pending: true }), // excluded
    tx('2026-05-03', 'Paycheck', -3000, { category: 'Income' }),
  ]
  assert.deepEqual(monthlyCashflowFromTransactions(txs), [
    { month: '2026-06', income: 3000, spending: 980, net: 2020, count: 2 },
    { month: '2026-05', income: 3000, spending: 0, net: 3000, count: 1 },
  ])
})

test('empty or undated transactions yield no buckets', () => {
  assert.deepEqual(monthlyCashflowFromTransactions([]), [])
  assert.deepEqual(monthlyCashflowFromTransactions([tx(null, 'No Date', 12)]), [])
})

test('forecast fed by transaction buckets is unaffected by pending charges', () => {
  // Same ledger with and without a large pending hold must forecast the same:
  // anomalies/subscriptions already exclude pending, so forecast/savings do too.
  const base = []
  for (const month of ['2026-04', '2026-05', '2026-06', '2026-07']) {
    base.push(tx(`${month}-01`, 'Paycheck', -6000, { category: 'Income' }))
    if (month !== '2026-07') base.push(tx(`${month}-10`, 'Rent', 4000, { category: 'Housing' }))
  }
  const pendingHold = tx('2026-07-10', 'Pending Card Hold', 999.99, { pending: true })
  const without = computeForecast({ cashNow: 1000, monthlyCashflow: monthlyCashflowFromTransactions(base), asOf: '2026-07-15' })
  const withPending = computeForecast({ cashNow: 1000, monthlyCashflow: monthlyCashflowFromTransactions([...base, pendingHold]), asOf: '2026-07-15' })
  assert.deepEqual(withPending, without)
  assert.equal(withPending.spendMtd, 0) // the pending hold never entered MTD spend
})
