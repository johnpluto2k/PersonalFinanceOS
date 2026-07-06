const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('C:/ClaudeProjects/MLB_Bot/node_modules/playwright')

const ROOT = __dirname
const SHOTS = path.join(ROOT, 'shots')
const URL = 'http://127.0.0.1:8787/'

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
    await page.locator(`.bottom-tabs [data-view="${view}"]`).scrollIntoViewIfNeeded()
    await page.locator(`.bottom-tabs [data-view="${view}"]`).click()
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

async function runCoreFlow(page) {
  const beforeDining = await getDiningBudget(page)
  const beforeSpend = Number(beforeDining?.spent || 0)
  const csv = [
    'Transaction Date,Description,Amount,Category',
    '07/04/2026,QA Test Cafe,12.34,Uncategorized',
  ].join('\n')

  await page.getByRole('button', { name: /Apple CSV/i }).click()
  await page.locator('#appleDialog textarea[name="csv"]').fill(csv)
  await page.locator('#appleForm button.primary-button').click()
  await page.waitForFunction(() => document.querySelector('#toastStack')?.textContent.includes('Imported'))

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
    await page.evaluate(() => document.querySelector('#toastStack')?.replaceChildren())
    screenshots.push(...await screenshotSections(page, 'desktop'))

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'networkidle' })
    await waitForTitle(page, 'Overview')
    screenshots.push(...await screenshotSections(page, 'mobile'))

    if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`)
    console.log(JSON.stringify({ ok: true, screenshots }, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exit(1)
})
