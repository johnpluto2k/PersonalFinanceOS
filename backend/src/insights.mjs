// Feature 3 "Smarter insights" — pure detection/forecast algorithms.
//
// This module is deliberately DB-free: every function takes plain transaction
// or cashflow arrays plus options and returns plain data. store.mjs imports it
// (one-directional — insights.mjs must never import from store.mjs), which keeps
// the dependency graph acyclic and the algorithms unit-testable with fixtures.
//
// Shared definitions (the auditor's contract — keep in lockstep with README):
// - Spend tx:   amount > 0 AND category !== 'Transfer' AND !pending
// - Income tx:  amount < 0 AND category !== 'Transfer' AND !pending
// - merchantKey: lower(trim(coalesce(merchant, description, 'Unknown')))
// - seriesKey (subscriptions): merchantKey + '|' + coalesce(accountId, '')
// - asOf: MAX(date) in the ledger (not wall clock)
//
// All money comparisons run in integer cents to avoid float drift; dollar
// values are only reconstructed at the response boundary.

// Category for movements between the user's OWN accounts. A transfer is
// neither income nor spending; every aggregation here (and store.mjs, which
// imports this constant) must skip it. Single source of truth.
export const TRANSFER_CATEGORY = 'Transfer'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function isSpendTx(tx) {
  return Number(tx.amount) > 0 && tx.category !== TRANSFER_CATEGORY && !tx.pending
}

export function isIncomeTx(tx) {
  return Number(tx.amount) < 0 && tx.category !== TRANSFER_CATEGORY && !tx.pending
}

export function merchantKeyOf(tx) {
  return String(tx.merchant || tx.description || 'Unknown').trim().toLowerCase()
}

export function seriesKeyOf(tx) {
  return `${merchantKeyOf(tx)}|${tx.accountId || ''}`
}

function merchantDisplay(tx) {
  return tx.merchant || tx.description || 'Unknown'
}

function toCents(value) {
  return Math.round(Number(value || 0) * 100)
}

function fromCents(cents) {
  return Math.round(cents) / 100
}

function round2(value) {
  return Math.round(value * 100) / 100
}

// Median of a numeric array (input not mutated).
function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// --- date-string math (all dates are 'YYYY-MM-DD' text, UTC) ---

function dateMs(dateText) {
  return Date.parse(`${String(dateText).slice(0, 10)}T00:00:00Z`)
}

function dayDiff(laterText, earlierText) {
  return Math.round((dateMs(laterText) - dateMs(earlierText)) / 86400000)
}

export function addDaysText(dateText, delta) {
  const date = new Date(dateMs(dateText))
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

export function monthOf(dateText) {
  return String(dateText).slice(0, 7)
}

export function addMonthsText(month, delta) {
  const [year, monthIndex] = String(month).split('-').map(Number)
  const date = new Date(Date.UTC(year, monthIndex - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function daysInMonthOf(month) {
  const [year, monthNumber] = String(month).split('-').map(Number)
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
}

function groupBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    const bucket = map.get(key)
    if (bucket) bucket.push(item)
    else map.set(key, [item])
  }
  return map
}

// O(n) max date over transactions (no sort); '' when none carry a date.
function latestDateOf(transactions) {
  let max = ''
  for (const tx of transactions) {
    if (tx.date && tx.date > max) max = tx.date
  }
  return max
}

// Monthly income/spend buckets computed directly from a transactions array
// using the shared spend/income definitions above — pending and Transfer rows
// are EXCLUDED. This is intentionally not the same series as /api/cashflow
// (store.listCashflow), which keeps pending rows: forecast and savings must
// agree with anomalies/subscriptions about which transactions exist. Returned
// newest-month-first; bucket shape matches listCashflow ({ month, income,
// spending, net, count }), integer-cent math throughout.
export function monthlyCashflowFromTransactions(transactions) {
  const byMonth = new Map()
  for (const tx of transactions) {
    if (!tx.date) continue
    const spend = isSpendTx(tx)
    const income = isIncomeTx(tx)
    if (!spend && !income) continue
    const month = monthOf(tx.date)
    const bucket = byMonth.get(month) || { month, incomeCents: 0, spendCents: 0, count: 0 }
    if (income) bucket.incomeCents += Math.abs(toCents(tx.amount))
    else bucket.spendCents += toCents(tx.amount)
    bucket.count += 1
    byMonth.set(month, bucket)
  }
  return [...byMonth.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((bucket) => ({
      month: bucket.month,
      income: fromCents(bucket.incomeCents),
      spending: fromCents(bucket.spendCents),
      net: fromCents(bucket.incomeCents - bucket.spendCents),
      count: bucket.count,
    }))
}

// ---------------------------------------------------------------------------
// 1a. Anomaly detection (robust z-score over merchant/category peer history)
// ---------------------------------------------------------------------------
//
// For each spend tx dated within `recentDays` of asOf:
// 1. Peer set = all OTHER spend txs with the same merchantKey dated within 365
//    days up to and including T.date (same-day peers count). If < 5 merchant
//    peers, fall back to same-category peers; if < 12 category peers, skip.
// 2. median/MAD of peer amounts; sigma = max(1.4826*MAD, 0.15*median, $1.00) —
//    the floor protects zero-variance series (Rent $980 x 12 has MAD = 0).
// 3. Flag only when ALL THREE hold:
//    robustZ = (amount - median)/sigma >= 3.5; amount >= 2*median;
//    amount - median >= $25.
// 4. severity = 'high' when amount >= 3*median, else 'medium'.
export function detectAnomalies(transactions, { asOf, recentDays = 60 } = {}) {
  const spend = transactions.filter((tx) => isSpendTx(tx) && tx.date)
  if (!spend.length) return []
  const asOfDate = String(asOf || latestDateOf(spend)).slice(0, 10)
  const windowStart = addDaysText(asOfDate, -recentDays)

  // Single pass grouping: peer lookups scan only the tx's own merchant/category
  // bucket, never the full ledger (no O(n^2) over all transactions). The
  // category grouping is built lazily — only when some merchant history is
  // actually too thin — since most ledgers never hit the fallback.
  const byMerchant = groupBy(spend, merchantKeyOf)
  let byCategory = null

  const peersFor = (group, tx) => {
    const earliest = addDaysText(tx.date, -365)
    return group.filter((p) => p.id !== tx.id && p.date <= tx.date && p.date >= earliest)
  }

  const anomalies = []
  for (const tx of spend) {
    if (tx.date < windowStart || tx.date > asOfDate) continue

    let basis = 'merchant'
    let peers = peersFor(byMerchant.get(merchantKeyOf(tx)) || [], tx)
    if (peers.length < 5) {
      basis = 'category'
      if (!byCategory) byCategory = groupBy(spend, (t) => t.category || 'Uncategorized')
      peers = peersFor(byCategory.get(tx.category || 'Uncategorized') || [], tx)
      if (peers.length < 12) continue
    }

    const peerCents = peers.map((p) => toCents(p.amount))
    const medianCents = median(peerCents)
    const madCents = median(peerCents.map((c) => Math.abs(c - medianCents)))
    const sigmaCents = Math.max(1.4826 * madCents, 0.15 * medianCents, 100)
    const amountCents = toCents(tx.amount)

    const robustZ = (amountCents - medianCents) / sigmaCents
    if (robustZ < 3.5) continue
    if (amountCents < 2 * medianCents) continue
    if (amountCents - medianCents < 2500) continue

    anomalies.push({
      id: `anomaly_${tx.id}`,
      transactionId: tx.id,
      date: tx.date,
      merchant: merchantDisplay(tx),
      category: tx.category || 'Uncategorized',
      amount: fromCents(amountCents),
      baseline: {
        basis,
        sampleSize: peers.length,
        median: fromCents(medianCents),
        mad: fromCents(madCents),
      },
      robustZ: round2(robustZ),
      multiple: medianCents > 0 ? round2(amountCents / medianCents) : null,
      severity: amountCents >= 3 * medianCents ? 'high' : 'medium',
    })
  }

  return anomalies.sort((a, b) => b.date.localeCompare(a.date) || b.robustZ - a.robustZ)
}

// ---------------------------------------------------------------------------
// 1b. Subscription detection v2 (cadence + amount-drift tolerance + price runs)
// ---------------------------------------------------------------------------

const CADENCES = [
  // center is the natural period length; conformity = share of intervals
  // within +/-20% of center. `days` drives nextExpectedDate; `perMonth`
  // converts the median charge into a monthly cost.
  { name: 'weekly', min: 6, max: 8, center: 7, days: 7, perMonth: 52 / 12 },
  { name: 'monthly', min: 25, max: 35, center: 30.44, days: 30, perMonth: 1 },
  { name: 'annual', min: 330, max: 400, center: 365.25, days: 365, perMonth: 1 / 12 },
]

// Best-effort default cadence for series listed via the 'Subscriptions'
// category exception when no cadence band matches. Hoisted so it is resolved
// once, not per series.
const MONTHLY_CADENCE = CADENCES.find((c) => c.name === 'monthly')

// Compress date-sorted charge amounts (cents) into runs of stable pricing.
// A new run starts when a charge differs from the CURRENT run's median by AT
// LEAST toleranceCents. (>= not >: the canonical Netflix case is a $2.00 bump
// against a $2.00 tolerance and must split — the plan's worked example is the
// contract; float-free cents math keeps the comparison exact.)
function priceRuns(chargeCents, toleranceCents) {
  const runs = []
  let run = null
  for (let i = 0; i < chargeCents.length; i += 1) {
    const cents = chargeCents[i]
    if (run && Math.abs(cents - median(run.cents)) >= toleranceCents) run = null
    if (!run) {
      run = { startIndex: i, cents: [] }
      runs.push(run)
    }
    run.cents.push(cents)
  }
  return runs
}

// Detect recurring charge series per (merchantKey, accountId). Response keeps
// every v1 field (merchant, category, monthlyCost, chargeCount, lastCharged,
// cadence, confidence) and adds seriesKey, accountId, medianAmount,
// amountTolerance, intervalConformity, amountConformity, nextExpectedDate,
// priceIncrease.
export function detectSubscriptionsV2(transactions) {
  const spend = transactions.filter((tx) => isSpendTx(tx) && tx.date)
  const groups = groupBy(spend, seriesKeyOf)

  const results = []
  for (const [seriesKey, txs] of groups) {
    const charges = [...txs].sort((a, b) => a.date.localeCompare(b.date))
    // v1 semantics: the series is described by its NEWEST charge, so a
    // merchant recategorized going forward is judged by its current category.
    const newest = charges.at(-1)
    const isSubscriptionCategory = newest.category === 'Subscriptions'

    const intervals = []
    for (let i = 1; i < charges.length; i += 1) {
      intervals.push(dayDiff(charges[i].date, charges[i - 1].date))
    }
    const medianInterval = intervals.length ? median(intervals) : null

    // Cadence: band containing the median interval. Monthly/weekly need >= 3
    // charges; annual only needs 2 (a single ~1-year gap is already strong).
    let cadence = null
    if (medianInterval != null) {
      const band = CADENCES.find((c) => medianInterval >= c.min && medianInterval <= c.max)
      if (band && charges.length >= (band.name === 'annual' ? 2 : 3)) cadence = band
    }

    const intervalConformity = cadence && intervals.length
      ? intervals.filter((gap) => Math.abs(gap - cadence.center) <= 0.2 * cadence.center).length / intervals.length
      : null

    const chargeCents = charges.map((tx) => toCents(tx.amount))
    const medianCents = median(chargeCents)
    const toleranceCents = Math.max(200, Math.round(0.05 * medianCents))

    // Per-run amount conformity: compress the series into stable price runs
    // FIRST, then require >= 70% of charges to live in runs of length >= 2.
    // A legitimate price increase (6 x $9.99 then 4 x $12.99) is two stable
    // runs covering 100% of charges, while erratic spending (every charge its
    // own run) scores 0. The old whole-series-median rule rejected exactly the
    // price-increase series this detector exists to find (6/10 = 0.6 < 0.7).
    const runs = priceRuns(chargeCents, toleranceCents)
    const stableCharges = runs.reduce((sum, run) => sum + (run.cents.length >= 2 ? run.cents.length : 0), 0)
    const amountConformity = stableCharges / chargeCents.length

    const passes = Boolean(cadence)
      && intervalConformity != null && intervalConformity >= 0.7
      && amountConformity >= 0.7
    // v1 exception carried forward: an explicit 'Subscriptions' category is
    // always listed, even when cadence/drift checks would reject it.
    if (!passes && !isSubscriptionCategory) continue

    // Price increase: the last run vs the nearest PRECEDING run of length >= 2,
    // and the last run itself must have >= 2 charges. Both guards matter: a
    // single charge at a new price is not yet a confirmed increase, and a
    // single discounted charge (promo month) sandwiched between stable runs
    // must not fabricate an "increase" measured against the promo price.
    // The increase must be at least max($1.00, 2% of previous).
    let priceIncrease = null
    const lastRun = runs[runs.length - 1]
    if (runs.length >= 2 && lastRun.cents.length >= 2) {
      let prevRun = null
      for (let i = runs.length - 2; i >= 0; i -= 1) {
        if (runs[i].cents.length >= 2) {
          prevRun = runs[i]
          break
        }
      }
      if (prevRun) {
        const lastMedian = median(lastRun.cents)
        const prevMedian = median(prevRun.cents)
        const deltaCents = lastMedian - prevMedian
        if (deltaCents >= Math.max(100, Math.round(0.02 * prevMedian))) {
          priceIncrease = {
            previousAmount: fromCents(prevMedian),
            newAmount: fromCents(lastMedian),
            delta: fromCents(deltaCents),
            percent: prevMedian > 0 ? Math.round((deltaCents / prevMedian) * 1000) / 10 : null,
            effectiveDate: charges[lastRun.startIndex].date,
            confirmedCharges: lastRun.cents.length,
          }
        }
      }
    }

    const effectiveCadence = cadence || MONTHLY_CADENCE
    let confidence = 0.5
    if (isSubscriptionCategory) confidence += 0.2
    if (intervalConformity != null && intervalConformity >= 0.85) confidence += 0.15
    if (amountConformity >= 0.9) confidence += 0.15
    confidence = Math.min(0.98, round2(confidence))

    // Headline cost reflects the CURRENT price (the last run's median), so a
    // series that just went up reads at its new rate ($17.49 Netflix, not the
    // all-time median $15.49). medianAmount keeps the whole-series median.
    const currentCents = median(lastRun.cents)
    const lastCharged = newest.date
    results.push({
      seriesKey,
      merchant: merchantDisplay(newest),
      category: newest.category || 'Uncategorized',
      accountId: newest.accountId || null,
      monthlyCost: round2(fromCents(currentCents) * effectiveCadence.perMonth),
      chargeCount: charges.length,
      lastCharged,
      cadence: effectiveCadence.name,
      confidence,
      medianAmount: fromCents(medianCents),
      amountTolerance: fromCents(toleranceCents),
      intervalConformity: intervalConformity == null ? null : round2(intervalConformity),
      amountConformity: round2(amountConformity),
      nextExpectedDate: addDaysText(lastCharged, effectiveCadence.days),
      priceIncrease,
    })
  }

  return results.sort((a, b) => b.monthlyCost - a.monthlyCost)
}

// ---------------------------------------------------------------------------
// 1c. End-of-month cash forecast (catch-up-to-baseline)
// ---------------------------------------------------------------------------
//
// baseline = average income/spend over the 3 complete calendar months before
// the asOf month. Buckets come from monthlyCashflowFromTransactions (pending
// and Transfer excluded — NOT /api/cashflow's buckets, which keep pending
// rows). Projection assumes the month will
// catch up to baseline where it is currently behind, and keeps actuals where
// it is already ahead:
//   projectedIncome   = max(incomeMtd, avgIncome)
//   projectedSpending = max(spendMtd, avgSpend)
//   projectedEndOfMonthCash = cashNow + (projectedIncome - incomeMtd)
//                                     - (projectedSpending - spendMtd)
export function computeForecast({ cashNow, monthlyCashflow = [], asOf } = {}) {
  const asOfDate = String(asOf || new Date().toISOString()).slice(0, 10)
  const month = monthOf(asOfDate)
  const byMonth = new Map(monthlyCashflow.map((bucket) => [bucket.month, bucket]))

  const baselineMonths = [addMonthsText(month, -3), addMonthsText(month, -2), addMonthsText(month, -1)]
  let baselineIncomeCents = 0
  let baselineSpendCents = 0
  for (const m of baselineMonths) {
    const bucket = byMonth.get(m)
    baselineIncomeCents += toCents(bucket?.income)
    baselineSpendCents += toCents(bucket?.spending)
  }
  const avgIncomeCents = Math.round(baselineIncomeCents / baselineMonths.length)
  const avgSpendCents = Math.round(baselineSpendCents / baselineMonths.length)

  const current = byMonth.get(month)
  const incomeMtdCents = toCents(current?.income)
  const spendMtdCents = toCents(current?.spending)

  const projectedIncomeCents = Math.max(incomeMtdCents, avgIncomeCents)
  const projectedSpendCents = Math.max(spendMtdCents, avgSpendCents)
  const cashNowCents = toCents(cashNow)
  const projectedEndCents = cashNowCents
    + (projectedIncomeCents - incomeMtdCents)
    - (projectedSpendCents - spendMtdCents)

  return {
    month,
    asOf: asOfDate,
    daysElapsed: Number(asOfDate.slice(8, 10)),
    daysInMonth: daysInMonthOf(month),
    cashNow: fromCents(cashNowCents),
    incomeMtd: fromCents(incomeMtdCents),
    spendMtd: fromCents(spendMtdCents),
    baselineMonths,
    avgIncome: fromCents(avgIncomeCents),
    avgSpend: fromCents(avgSpendCents),
    projectedIncome: fromCents(projectedIncomeCents),
    projectedSpending: fromCents(projectedSpendCents),
    projectedNet: fromCents(projectedIncomeCents - projectedSpendCents),
    projectedEndOfMonthCash: fromCents(projectedEndCents),
  }
}

// ---------------------------------------------------------------------------
// 1d. Savings rates over complete months
// ---------------------------------------------------------------------------
//
// rate_N = (sum(income) - sum(spend)) / sum(income) over the N complete
// calendar months strictly before asOfMonth (the partial current month is
// excluded); null when total income is 0.
export function computeSavingsRates(monthlyCashflow = [], asOfMonth) {
  const byMonth = new Map(monthlyCashflow.map((bucket) => [bucket.month, bucket]))
  const windowFor = (n) => {
    const months = []
    for (let i = n; i >= 1; i -= 1) months.push(addMonthsText(asOfMonth, -i))
    let incomeCents = 0
    let spendCents = 0
    for (const m of months) {
      const bucket = byMonth.get(m)
      incomeCents += toCents(bucket?.income)
      spendCents += toCents(bucket?.spending)
    }
    return {
      rate: incomeCents > 0 ? Math.round(((incomeCents - spendCents) / incomeCents) * 10000) / 10000 : null,
      income: fromCents(incomeCents),
      spending: fromCents(spendCents),
      months,
    }
  }
  return { threeMonth: windowFor(3), sixMonth: windowFor(6) }
}
