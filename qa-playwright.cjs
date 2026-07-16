const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('C:/ClaudeProjects/MLB_Bot/node_modules/playwright')

const ROOT = __dirname
const SHOTS = path.join(ROOT, 'shots')
const PORT = process.env.PORT || 8788
const URL = `http://127.0.0.1:${PORT}/`

const sections = [
  ['overview', 'Overview'],
  ['transactions', 'Transactions'],
  ['budgets', 'Budgets'],
  ['cashflow', 'Cashflow'],
  ['subscriptions', 'Subscriptions'],
  ['accounts', 'Accounts'],
  ['documents', 'Documents'],
  ['taxes', 'Taxes'],
  ['automation', 'Automation'],
  ['connections', 'Connections'],
]

fs.mkdirSync(SHOTS, { recursive: true })

async function checkNoHorizontalOverflow(page, label) {
  const result = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  if (result.scrollWidth > result.width + 2) {
    throw new Error(`${label} has horizontal overflow: ${result.scrollWidth} > ${result.width}`)
  }
}

async function waitForTitle(page, title) {
  await page.waitForFunction((expected) => document.querySelector('#viewTitle')?.textContent === expected, title)
}

async function openView(page, view, title, mode) {
  if (mode === 'desktop') {
    await page.locator(`.sidebar [data-view="${view}"]`).click()
  } else {
    // On mobile, some views are in the bottom tabs, others are in the More menu
    const directViews = ['overview', 'transactions', 'budgets', 'accounts']
    const moreMenuViews = ['cashflow', 'subscriptions', 'documents', 'taxes', 'automation', 'connections']

    if (directViews.includes(view)) {
      // Click directly from bottom tabs
      await page.locator(`.bottom-tabs [data-view="${view}"]`).click()
    } else if (moreMenuViews.includes(view)) {
      // Open More menu first
      await page.locator('#moreMenuBtn').click()
      await page.locator(`.more-menu-item[data-view="${view}"]`).click()
    }
  }
  await waitForTitle(page, title)
  await page.waitForTimeout(220)
  await checkNoHorizontalOverflow(page, `${mode} ${view}`)
}

async function getDiningBudget(page) {
  const budgets = await page.evaluate(async () => {
    const res = await fetch('/api/budgets')
    return res.json()
  })
  return budgets.find((budget) => budget.category === 'Dining')
}

async function importAppleCsv(page, csv) {
  await page.evaluate(() => document.querySelector('#toastStack')?.replaceChildren())
  await page.getByRole('button', { name: /Apple CSV/i }).click()
  await page.locator('#appleDialog textarea[name="csv"]').fill(csv)
  await page.locator('#appleForm button.primary-button').click()
  await page.waitForFunction(() => document.querySelector('#toastStack')?.textContent.includes('Imported'))
}

async function runCoreFlow(page) {
  const beforeDining = await getDiningBudget(page)
  const beforeSpend = Number(beforeDining?.spent || 0)
  const csv = [
    'Transaction Date,Description,Amount,Category',
    '07/04/2026,QA Test Cafe,12.34,Uncategorized',
  ].join('\n')

  await importAppleCsv(page, csv)

  // Feature 3 (smarter insights): inject an anomalous Chipotle charge.
  // The import endpoint hashes date+merchant+amount into the row id, so
  // re-running this import is an id-idempotent no-op (same as the QA Test
  // Cafe row above, which the flow also leaves in place).
  const anomalyCsv = [
    'Transaction Date,Description,Amount,Category',
    '07/05/2026,Chipotle,180.00,Dining',
  ].join('\n')
  await importAppleCsv(page, anomalyCsv)

  await openView(page, 'transactions', 'Transactions', 'desktop')
  await page.locator('#txSearch').fill('QA Test Cafe')
  const row = page.locator('#transactionTable tr', { hasText: 'QA Test Cafe' }).first()
  await row.waitFor()
  await row.locator('.always-check').check()
  await row.locator('.category-select').selectOption('Dining')
  await page.waitForFunction(() => document.querySelector('#toastStack')?.textContent.match(/Category/))

  await openView(page, 'budgets', 'Budgets', 'desktop')
  await page.locator('#budgetGrid').waitFor()
  const afterDining = await getDiningBudget(page)
  if (!afterDining || Number(afterDining.spent || 0) < beforeSpend) {
    throw new Error('Dining budget did not remain updated after recategorization')
  }

  const tx = await page.evaluate(async () => {
    const res = await fetch('/api/transactions?limit=500')
    const txs = await res.json()
    return txs.find((item) => item.merchant === 'QA Test Cafe')
  })
  if (!tx || tx.category !== 'Dining') {
    throw new Error('QA transaction was not categorized as Dining')
  }
}

async function runInsightsChecks(page) {
  const data = await page.evaluate(async () => {
    const [insights, queue, summary] = await Promise.all([
      fetch('/api/insights').then((res) => res.json()),
      fetch('/api/action-queue').then((res) => res.json()),
      fetch('/api/summary').then((res) => res.json()),
    ])
    return { insights, queue, summary }
  })

  const anomalies = data.insights?.anomalies
  if (!Array.isArray(anomalies)) {
    throw new Error('/api/insights did not return an anomalies array')
  }
  const chipotle = anomalies.find(
    (item) => /chipotle/i.test(item.merchant || '') && Math.abs(Number(item.amount) - 180) < 0.005,
  )
  if (!chipotle) {
    throw new Error(
      `/api/insights anomalies missing the $180 Chipotle entry. Got: ${JSON.stringify(
        anomalies.map((a) => ({ merchant: a.merchant, amount: a.amount })),
      )}`,
    )
  }

  const queueItems = Array.isArray(data.queue) ? data.queue : data.queue?.items
  if (!Array.isArray(queueItems)) {
    throw new Error('/api/action-queue did not return an item array')
  }
  const queueItem = queueItems.find((item) => /^Unusual charge: Chipotle/i.test(item.title || ''))
  if (!queueItem) {
    throw new Error(
      `/api/action-queue missing "Unusual charge: Chipotle" item. Titles: ${JSON.stringify(
        queueItems.map((item) => item.title),
      )}`,
    )
  }

  const rate = data.summary?.savingsRate3m
  if (!Number.isFinite(rate) || rate <= -1 || rate >= 1) {
    throw new Error(`summary.savingsRate3m is not a finite value in (-1, 1): ${rate}`)
  }
  const forecast = data.summary?.forecastEndOfMonthCash
  if (!Number.isFinite(forecast)) {
    throw new Error(`summary.forecastEndOfMonthCash is not finite: ${forecast}`)
  }

  return {
    anomaly: chipotle,
    queueItem: { title: queueItem.title, detail: queueItem.detail, priority: queueItem.priority, type: queueItem.type },
    savingsRate3m: rate,
    savingsRate6m: data.summary?.savingsRate6m,
    forecastEndOfMonthCash: forecast,
  }
}

async function runInsightsUiChecks(page) {
  // Fresh render so the Overview reflects the transactions injected by the
  // core flow (state is fetched at load, not on view switch).
  await page.reload({ waitUntil: 'networkidle' })
  await waitForTitle(page, 'Overview')

  const queueRow = page.locator('#actionQueue', { hasText: 'Unusual charge: Chipotle' })
  await queueRow.waitFor({ timeout: 5000 }).catch(() => {
    throw new Error('Overview action queue does not render the "Unusual charge: Chipotle" anomaly row')
  })
  const anomalyChip = await page.locator('#actionQueue .chip', { hasText: /anomaly/i }).count()
  if (anomalyChip === 0) {
    throw new Error('Anomaly row in the action queue is missing its "anomaly" chip')
  }

  const savingsText = (await page.locator('#savingsRateMetric').textContent())?.trim()
  if (!savingsText || savingsText === 'n/a' || !/%/.test(savingsText) || /NaN/i.test(savingsText)) {
    throw new Error(`Savings-rate tile is not rendering a percentage: "${savingsText}"`)
  }
  const forecastText = (await page.locator('#forecastValue').textContent())?.trim()
  if (!forecastText || forecastText === 'n/a' || !/\$/.test(forecastText) || /NaN/i.test(forecastText)) {
    throw new Error(`EOM forecast tile is not rendering a money value: "${forecastText}"`)
  }

  await openView(page, 'subscriptions', 'Subscriptions', 'desktop')
  const netflixCard = page.locator('#subscriptionGrid article', { hasText: 'Netflix' }).first()
  await netflixCard.waitFor({ timeout: 5000 }).catch(() => {
    throw new Error('Subscriptions grid does not render a Netflix card')
  })
  const netflixText = await netflixCard.textContent()
  if (!/17\.49/.test(netflixText)) {
    throw new Error(`Netflix card headline is not the current price $17.49: "${netflixText.slice(0, 200)}"`)
  }
  const priceUpBadge = await netflixCard.locator('.price-up', { hasText: /2\.00/ }).count()
  if (priceUpBadge === 0) {
    throw new Error('Netflix card is missing its "↑ $2.00" price-increase badge')
  }
  const summaryText = (await page.locator('#subscriptionSummary').textContent())?.trim()
  if (!summaryText || !/recurring/i.test(summaryText) || !/\$/.test(summaryText)) {
    throw new Error(`Subscription summary strip is not rendering totals: "${summaryText}"`)
  }

  await openView(page, 'overview', 'Overview', 'desktop')
  return {
    savingsTile: savingsText,
    forecastTile: forecastText,
    netflixBadge: true,
    subscriptionSummary: summaryText.replace(/\s+/g, ' ').slice(0, 120),
  }
}

async function screenshotSections(page, mode) {
  const shots = []
  for (const [view, title] of sections) {
    await openView(page, view, title, mode)
    const file = path.join(SHOTS, `${mode}-${view}.png`)
    await page.screenshot({ path: file, fullPage: true })
    shots.push(file)
  }
  return shots
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const errors = []
  const screenshots = []
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto(URL, { waitUntil: 'networkidle' })
    await waitForTitle(page, 'Overview')
    await page.locator('#netWorthValue').waitFor()

    await runCoreFlow(page)
    const insights = await runInsightsChecks(page)
    const insightsUi = await runInsightsUiChecks(page)
    await page.evaluate(() => document.querySelector('#toastStack')?.replaceChildren())
    screenshots.push(...await screenshotSections(page, 'desktop'))

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'networkidle' })
    await waitForTitle(page, 'Overview')
    screenshots.push(...await screenshotSections(page, 'mobile'))

    if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)
    console.log(JSON.stringify({ ok: true, insights, insightsUi, screenshots }, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exit(1)
})
