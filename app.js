const API = location.protocol === 'file:' ? 'http://127.0.0.1:8787' : ''

const state = {
  health: null,
  summary: null,
  accounts: [],
  connections: [],
  transactions: [],
  actions: [],
  cashflow: [],
  documents: [],
  taxes: [],
  budgets: [],
  rules: [],
  history: { snapshots: [], cashflow: [], categories: [] },
  subscriptions: [],
  categories: [],
  view: 'overview',
  historyRange: '1Y',
  txSearch: '',
  txCategory: 'all',
  txSort: { key: 'date', dir: 'desc' },
  documentYear: null,
  taxYear: null,
}

const viewMeta = {
  overview: ['Personal CFO', 'Overview'],
  transactions: ['Unified ledger', 'Transactions'],
  budgets: ['Plan vs actual', 'Budgets'],
  cashflow: ['Income vs spend', 'Cashflow'],
  subscriptions: ['Recurring detection', 'Subscriptions'],
  accounts: ['Balance sheet', 'Accounts'],
  documents: ['Evidence locker', 'Documents'],
  taxes: ['Filing prep', 'Taxes'],
  automation: ['Categorization', 'Automation'],
  connections: ['Providers', 'Connections'],
}

const chartColors = ['#3ddc97', '#a78bfa', '#38bdf8', '#f59e0b', '#fb7185', '#22c55e', '#e879f9', '#f97316']

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const preciseMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

function $(id) {
  return document.getElementById(id)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(value, precise = false) {
  return (precise ? preciseMoney : money).format(Number(value || 0))
}

function safeColor(value, fallback = '#3ddc97') {
  return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? String(value) : fallback
}

function fmtAmount(amount) {
  const n = Number(amount || 0)
  return n < 0 ? `+${fmtMoney(Math.abs(n), true)}` : fmtMoney(n, true)
}

function amountClass(amount) {
  return Number(amount || 0) < 0 ? 'money inflow' : 'money outflow'
}

function accountKind(kind) {
  return String(kind || 'other').replace(/_/g, ' ')
}

function clearSkeleton(id) {
  const el = $(id)
  if (el) el.classList.remove('skeleton')
  return el
}

function setText(id, value) {
  const el = $(id)
  if (el) el.textContent = value
}

function setAnimated(id, value, formatter = (n) => String(Math.round(n))) {
  const el = $(id)
  if (!el) return
  const next = Number(value || 0)
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const previous = Number(el.dataset.value || next)
  el.dataset.value = String(next)
  if (prefersReduced || previous === next) {
    el.textContent = formatter(next)
    return
  }
  const start = performance.now()
  const duration = 420
  const tick = (time) => {
    const t = Math.min(1, (time - start) / duration)
    const eased = 1 - Math.pow(1 - t, 3)
    el.textContent = formatter(previous + (next - previous) * eased)
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `${path} returned ${res.status}`)
  return json
}

function get(path) {
  return request(path)
}

function post(path, body = {}) {
  return request(path, { method: 'POST', body: JSON.stringify(body) })
}

function patch(path, body = {}) {
  return request(path, { method: 'PATCH', body: JSON.stringify(body) })
}

function toast(message, tone = 'info') {
  const stack = $('toastStack')
  const item = document.createElement('div')
  item.className = tone === 'error' ? 'toast error' : 'toast'
  item.textContent = message
  stack.append(item)
  window.setTimeout(() => item.remove(), 4200)
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`
}

function listRow({ title, detail, right, chip, tone = '' }) {
  return `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(title)}</strong>
        ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
      </div>
      <div>
        ${right ? `<span class="${String(right).includes('$') ? 'money' : ''}">${escapeHtml(right)}</span>` : ''}
        ${chip ? `<span class="chip ${tone}">${escapeHtml(chip)}</span>` : ''}
      </div>
    </div>
  `
}

function financeCard({ title, meta, value, body, chip, tone = '', accent = '#3ddc97', extra = '' }) {
  return `
    <article class="finance-card" style="border-top: 3px solid ${safeColor(accent)}">
      <div class="finance-card-top">
        <div>
          <span class="label">${escapeHtml(meta || '')}</span>
          <h3>${escapeHtml(title)}</h3>
        </div>
        ${chip ? `<span class="chip ${tone}">${escapeHtml(chip)}</span>` : ''}
      </div>
      ${value ? `<div class="big">${escapeHtml(value)}</div>` : ''}
      ${body ? `<p>${escapeHtml(body)}</p>` : ''}
      ${extra}
    </article>
  `
}

function progressBar(percent, color = '#3ddc97') {
  const width = Math.max(0, Math.min(100, Number(percent || 0)))
  return `<div class="progress-track"><span class="progress-fill" style="width:${width}%;background:${safeColor(color)}"></span></div>`
}

function lineChart(points) {
  if (!points?.length) return emptyState('No history yet.')
  const width = 760
  const height = 220
  const pad = 24
  const values = points.map((p) => Number(p.netWorth || 0))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(1, max - min)
  const xStep = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0
  const coords = points.map((point, index) => {
    const x = pad + index * xStep
    const y = height - pad - ((Number(point.netWorth || 0) - min) / span) * (height - pad * 2)
    return { x, y, point }
  })
  const path = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const area = `${path} L${coords.at(-1).x.toFixed(1)} ${height - pad} L${coords[0].x.toFixed(1)} ${height - pad} Z`
  const grid = [0.25, 0.5, 0.75].map((t) => {
    const y = pad + t * (height - pad * 2)
    return `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" stroke="#1b242e" />`
  }).join('')
  const dots = coords.map((p) => `
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#3ddc97">
      <title>${escapeHtml(`${p.point.date}: ${fmtMoney(p.point.netWorth)}`)}</title>
    </circle>
  `).join('')
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Net worth history">
      ${grid}
      <path d="${area}" fill="rgba(61, 220, 151, 0.10)" stroke="none"></path>
      <path d="${path}" fill="none" stroke="#3ddc97" stroke-width="3"></path>
      ${dots}
      <text x="${pad}" y="${height - 7}" fill="#65726f" font-size="12">${escapeHtml(points[0].date)}</text>
      <text x="${width - pad}" y="${height - 7}" fill="#65726f" font-size="12" text-anchor="end">${escapeHtml(points.at(-1).date)}</text>
    </svg>
  `
}

function cashflowBars(months) {
  const data = (months || []).slice(-8)
  if (!data.length) return emptyState('No cashflow yet.')
  const width = 760
  const height = 360
  const pad = 34
  const max = Math.max(...data.flatMap((m) => [Number(m.income || 0), Number(m.spending || 0)]), 1)
  const group = (width - pad * 2) / data.length
  const barWidth = Math.min(28, group / 3)
  const bars = data.map((month, index) => {
    const x = pad + index * group + group / 2
    const incomeH = (Number(month.income || 0) / max) * (height - pad * 2)
    const spendH = (Number(month.spending || 0) / max) * (height - pad * 2)
    return `
      <rect x="${x - barWidth - 2}" y="${height - pad - incomeH}" width="${barWidth}" height="${incomeH}" rx="4" fill="#3ddc97">
        <title>${escapeHtml(`${month.month} income ${fmtMoney(month.income)}`)}</title>
      </rect>
      <rect x="${x + 2}" y="${height - pad - spendH}" width="${barWidth}" height="${spendH}" rx="4" fill="#a78bfa">
        <title>${escapeHtml(`${month.month} spend ${fmtMoney(month.spending)}`)}</title>
      </rect>
      <text x="${x}" y="${height - 10}" fill="#65726f" font-size="11" text-anchor="middle">${escapeHtml(month.month.slice(5))}</text>
    `
  }).join('')
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly cashflow">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#25303b" />
      ${bars}
      <text x="${pad}" y="20" fill="#91a09b" font-size="12">Income</text>
      <circle cx="${pad + 53}" cy="16" r="5" fill="#3ddc97" />
      <text x="${pad + 72}" y="20" fill="#91a09b" font-size="12">Spend</text>
      <circle cx="${pad + 118}" cy="16" r="5" fill="#a78bfa" />
    </svg>
  `
}

function donutChart(items) {
  const data = (items || []).filter((item) => item.total > 0).slice(0, 7)
  if (!data.length) return emptyState('No category spend yet.')
  const total = data.reduce((sum, item) => sum + Number(item.total || 0), 0)
  const radius = 58
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const circles = data.map((item, index) => {
    const portion = Number(item.total || 0) / total
    const dash = portion * circumference
    const color = chartColors[index % chartColors.length]
    const circle = `
      <circle r="${radius}" cx="75" cy="75" fill="none" stroke="${color}" stroke-width="18"
        stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 75 75)">
        <title>${escapeHtml(`${item.category}: ${fmtMoney(item.total)}`)}</title>
      </circle>
    `
    offset += dash
    return circle
  }).join('')
  const legend = data.map((item, index) => `
    <div class="legend-row">
      <span class="legend-dot" style="background:${chartColors[index % chartColors.length]}"></span>
      <span>${escapeHtml(item.category)}</span>
      <strong>${escapeHtml(fmtMoney(item.total))}</strong>
    </div>
  `).join('')
  return `
    <div class="donut-layout">
      <svg viewBox="0 0 150 150" role="img" aria-label="Spending by category">
        <circle r="${radius}" cx="75" cy="75" fill="none" stroke="#151d27" stroke-width="18"></circle>
        ${circles}
        <text x="75" y="71" text-anchor="middle" fill="#edf5f2" font-size="18" font-weight="800">${escapeHtml(fmtMoney(total))}</text>
        <text x="75" y="91" text-anchor="middle" fill="#91a09b" font-size="11">spend</text>
      </svg>
      <div class="legend">${legend}</div>
    </div>
  `
}

function renderOverview() {
  const s = state.summary || {}
  setAnimated('netWorthValue', s.netWorth, (n) => fmtMoney(n))
  setAnimated('assetTotal', s.assets, (n) => fmtMoney(n))
  setAnimated('debtTotal', s.debt, (n) => fmtMoney(n))
  setText('runwayValue', s.cashRunwayMonths == null ? 'n/a' : `${s.cashRunwayMonths} mo`)
  setAnimated('incomeMetric', s.income30, (n) => fmtMoney(n))
  setAnimated('spendMetric', s.spending30, (n) => fmtMoney(n))
  setAnimated('accountMetric', s.accounts, (n) => String(Math.round(n)))
  setAnimated('actionMetric', s.actions, (n) => String(Math.round(n)))
  setText('incomeMeta', s.latestMonth || 'This month')
  setText('spendMeta', s.latestMonth || 'This month')
  setText('connectionMeta', `${s.connections || 0} links`)
  setText('docMeta', `${s.missingDocs || 0} docs`)

  document.querySelectorAll('#historyRanges button').forEach((button) => {
    button.classList.toggle('active', button.dataset.range === state.historyRange)
  })

  clearSkeleton('netWorthChart').innerHTML = lineChart(state.history.snapshots)
  renderActionQueue()
  renderBudgetPulse()
  renderRecentTransactions()
  clearSkeleton('categoryDonut').innerHTML = donutChart(state.history.categories)
}

function renderActionQueue() {
  const target = clearSkeleton('actionQueue')
  if (!state.actions.length) {
    target.innerHTML = emptyState('No urgent actions.')
    return
  }
  target.innerHTML = state.actions.slice(0, 6).map((action) => listRow({
    title: action.title,
    detail: action.detail,
    chip: action.priority,
    tone: action.priority === 'high' ? 'bad' : 'warn',
  })).join('')
}

function renderBudgetPulse() {
  const target = clearSkeleton('budgetPulse')
  if (!state.budgets.length) {
    target.innerHTML = emptyState('No budgets yet.')
    return
  }
  target.innerHTML = state.budgets
    .slice()
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 5)
    .map((budget) => listRow({
      title: budget.category,
      detail: `${budget.percent}% used in ${budget.month}`,
      right: budget.remaining < 0 ? `${fmtMoney(Math.abs(budget.remaining))} over` : `${fmtMoney(budget.remaining)} left`,
      chip: budget.remaining < 0 ? 'over' : 'on track',
      tone: budget.remaining < 0 ? 'bad' : budget.percent > 80 ? 'warn' : 'good',
    })).join('')
}

function renderRecentTransactions() {
  const target = clearSkeleton('recentTransactions')
  if (!state.transactions.length) {
    target.innerHTML = emptyState('No transactions yet.')
    return
  }
  target.innerHTML = state.transactions.slice(0, 7).map((tx) => `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(tx.merchant || tx.description || 'Transaction')}</strong>
        <p>${escapeHtml(`${tx.date || 'No date'} | ${tx.category || 'Uncategorized'} | ${tx.provider || ''}`)}</p>
      </div>
      <div class="${amountClass(tx.amount)}">${escapeHtml(fmtAmount(tx.amount))}</div>
    </div>
  `).join('')
}

function sortedFilteredTransactions() {
  const query = state.txSearch.trim().toLowerCase()
  const rows = state.transactions.filter((tx) => {
    const matchesQuery = !query || `${tx.date} ${tx.merchant} ${tx.description} ${tx.category} ${tx.provider}`.toLowerCase().includes(query)
    const matchesCategory = state.txCategory === 'all' || tx.category === state.txCategory
    return matchesQuery && matchesCategory
  })
  const { key, dir } = state.txSort
  rows.sort((a, b) => {
    const av = key === 'amount' ? Number(a.amount || 0) : String(a[key] || '')
    const bv = key === 'amount' ? Number(b.amount || 0) : String(b[key] || '')
    const result = typeof av === 'number' ? av - bv : av.localeCompare(bv)
    return dir === 'asc' ? result : -result
  })
  return rows
}

function renderTransactionControls() {
  const search = $('txSearch')
  const filter = $('categoryFilter')
  if (search && document.activeElement !== search) search.value = state.txSearch
  if (filter) {
    filter.innerHTML = [
      '<option value="all">All categories</option>',
      ...state.categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`),
    ].join('')
    filter.value = state.txCategory
  }
}

function renderTransactions() {
  renderTransactionControls()
  const tbody = $('transactionTable')
  const rows = sortedFilteredTransactions()
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5">${emptyState('No matching transactions.')}</td></tr>`
    return
  }
  const categoryOptions = (selected) => state.categories.map((category) => (
    `<option value="${escapeHtml(category)}" ${category === selected ? 'selected' : ''}>${escapeHtml(category)}</option>`
  )).join('')
  tbody.innerHTML = rows.map((tx) => `
    <tr>
      <td data-label="Date">${escapeHtml(tx.date || '')}</td>
      <td data-label="Merchant">
        <strong>${escapeHtml(tx.merchant || tx.description || 'Transaction')}</strong>
        <p>${escapeHtml(tx.description || '')}</p>
      </td>
      <td data-label="Category">
        <div class="category-editor">
          <select class="category-select" data-id="${escapeHtml(tx.id)}" aria-label="Category for ${escapeHtml(tx.merchant || 'transaction')}">
            ${categoryOptions(tx.category || 'Uncategorized')}
          </select>
          <label class="inline-check"><input class="always-check" type="checkbox" />Always</label>
        </div>
      </td>
      <td data-label="Source"><span class="chip">${escapeHtml(tx.provider || tx.source || '')}</span></td>
      <td data-label="Amount" class="${amountClass(tx.amount)} number">${escapeHtml(fmtAmount(tx.amount))}</td>
    </tr>
  `).join('')
}

function renderBudgets() {
  const target = $('budgetGrid')
  if (!state.budgets.length) {
    target.innerHTML = emptyState('No budgets yet.')
    return
  }
  target.innerHTML = state.budgets.map((budget) => {
    const over = budget.remaining < 0
    const merchants = budget.topMerchants?.length
      ? `<div class="merchant-list">${budget.topMerchants.map((m) => `<span class="chip">${escapeHtml(`${m.merchant} ${fmtMoney(m.total)}`)}</span>`).join('')}</div>`
      : ''
    return financeCard({
      title: budget.category,
      meta: budget.month,
      value: `${Math.round(budget.percent)}%`,
      chip: over ? 'over' : budget.percent > 80 ? 'watch' : 'ok',
      tone: over ? 'bad' : budget.percent > 80 ? 'warn' : 'good',
      accent: budget.color,
      body: `${fmtMoney(budget.spent)} of ${fmtMoney(budget.monthlyLimit)} | ${budget.deltaFromPrevious >= 0 ? '+' : ''}${fmtMoney(budget.deltaFromPrevious)} vs prior month`,
      extra: `${progressBar(budget.percent, budget.color)}${merchants}`,
    })
  }).join('')
}

function renderCashflow() {
  clearSkeleton('cashflowChart').innerHTML = cashflowBars(state.cashflow.slice().reverse())
  const target = clearSkeleton('cashflowStats')
  if (!state.cashflow.length) {
    target.innerHTML = emptyState('No cashflow yet.')
    return
  }
  target.innerHTML = state.cashflow.slice(0, 8).map((month) => listRow({
    title: month.month,
    detail: `${month.count} transactions`,
    right: `Net ${fmtMoney(month.net)}`,
    chip: month.net >= 0 ? 'positive' : 'negative',
    tone: month.net >= 0 ? 'good' : 'bad',
  })).join('')
}

function renderSubscriptions() {
  const target = $('subscriptionGrid')
  if (!state.subscriptions.length) {
    target.innerHTML = emptyState('No recurring charges detected.')
    return
  }
  target.innerHTML = state.subscriptions.map((item) => financeCard({
    title: item.merchant,
    meta: item.cadence,
    value: fmtMoney(item.monthlyCost, true),
    chip: `${Math.round(item.confidence * 100)}%`,
    tone: item.confidence > 0.9 ? 'good' : 'warn',
    accent: item.category === 'Subscriptions' ? '#a78bfa' : '#38bdf8',
    body: `${item.chargeCount} charges | last ${item.lastCharged || 'unknown'}`,
  })).join('')
}

function renderAccounts() {
  const target = $('accountGrid')
  if (!state.accounts.length) {
    target.innerHTML = emptyState('No accounts yet.')
    return
  }
  target.innerHTML = state.accounts.map((account) => {
    const isDebt = ['credit', 'loan', 'student_loan', 'mortgage'].includes(account.kind)
    return financeCard({
      title: account.name,
      meta: account.institution || account.provider,
      value: fmtMoney(Math.abs(account.balance), true),
      chip: account.importOnly ? 'import' : account.provider,
      tone: account.importOnly ? 'warn' : 'good',
      accent: isDebt ? '#fb7185' : account.kind === 'investment' ? '#a78bfa' : '#3ddc97',
      body: `${accountKind(account.kind)}${account.lastSyncAt ? ` | synced ${account.lastSyncAt.slice(0, 10)}` : ''}`,
    })
  }).join('')
}

function yearsFrom(items, field) {
  return [...new Set(items.map((item) => item[field]).filter(Boolean))].sort((a, b) => b - a)
}

function renderYearSelect(id, years, selected) {
  const select = $(id)
  if (!select) return
  select.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join('')
  select.value = selected
}

function renderDocuments() {
  const years = yearsFrom(state.documents, 'taxYear')
  state.documentYear ||= years[0] || new Date().getFullYear()
  renderYearSelect('documentYear', years, state.documentYear)
  const docs = state.documents.filter((doc) => Number(doc.taxYear) === Number(state.documentYear))
  const verified = docs.filter((doc) => doc.status === 'verified').length
  const received = docs.filter((doc) => doc.status === 'received').length
  const percent = docs.length ? Math.round((verified / docs.length) * 100) : 0
  $('documentProgress').innerHTML = `
    <div class="finance-card-top">
      <div><span class="label">${escapeHtml(String(state.documentYear))}</span><h3>${verified} of ${docs.length} verified</h3></div>
      <span class="chip ${percent === 100 ? 'good' : 'warn'}">${percent}%</span>
    </div>
    ${progressBar(percent, percent === 100 ? '#3ddc97' : '#f59e0b')}
    <p>${received} received and waiting for verification.</p>
  `
  const target = $('documentGrid')
  if (!docs.length) {
    target.innerHTML = emptyState('No documents for this year.')
    return
  }
  const toneForStatus = { verified: 'good', received: 'warn', needed: 'bad' }
  target.innerHTML = docs.map((doc) => financeCard({
    title: doc.title,
    meta: doc.institution || doc.kind,
    chip: doc.status,
    tone: toneForStatus[doc.status] || '',
    accent: doc.status === 'verified' ? '#3ddc97' : doc.status === 'received' ? '#f59e0b' : '#fb7185',
    body: `${doc.dueDate ? `Due ${doc.dueDate}` : 'No due date'}${doc.notes ? ` | ${doc.notes}` : ''}`,
  })).join('')
}

function daysUntil(dateText) {
  if (!dateText) return null
  const today = new Date()
  const due = new Date(`${dateText}T00:00:00`)
  return Math.ceil((due - today) / 86400000)
}

function renderTaxes() {
  const years = yearsFrom(state.taxes, 'taxYear')
  state.taxYear ||= years[0] || new Date().getFullYear()
  renderYearSelect('taxYear', years, state.taxYear)
  const tasks = state.taxes.filter((task) => Number(task.taxYear) === Number(state.taxYear))
  const taskTarget = clearSkeleton('taxTaskList')
  if (!tasks.length) {
    taskTarget.innerHTML = emptyState('No tax tasks for this year.')
  } else {
    taskTarget.innerHTML = tasks.map((task) => {
      const days = daysUntil(task.dueDate)
      const due = days == null ? 'No due date' : days < 0 ? `${Math.abs(days)} days late` : `${days} days`
      return listRow({
        title: task.title,
        detail: task.notes,
        right: due,
        chip: task.priority,
        tone: task.priority === 'high' ? 'bad' : task.priority === 'medium' ? 'warn' : '',
      })
    }).join('')
  }

  const deductibleCategories = ['Education', 'Health', 'Taxes', 'Investment']
  const groups = new Map()
  for (const tx of state.transactions) {
    if (tx.amount <= 0 || !deductibleCategories.includes(tx.category)) continue
    const group = groups.get(tx.category) || { category: tx.category, total: 0, count: 0 }
    group.total += Number(tx.amount || 0)
    group.count += 1
    groups.set(tx.category, group)
  }
  const rows = [...groups.values()].sort((a, b) => b.total - a.total)
  const target = clearSkeleton('deductionTracker')
  target.innerHTML = rows.length
    ? rows.map((row) => listRow({
      title: row.category,
      detail: `${row.count} tagged transactions`,
      right: fmtMoney(row.total, true),
      chip: 'tagged',
      tone: 'good',
    })).join('')
    : emptyState('No deduction tags yet.')
}

function renderAutomation() {
  const target = $('ruleGrid')
  if (!state.rules.length) {
    target.innerHTML = emptyState('No rules yet.')
    return
  }
  target.innerHTML = state.rules.map((rule) => financeCard({
    title: rule.pattern,
    meta: rule.target,
    chip: rule.enabled ? 'enabled' : 'off',
    tone: rule.enabled ? 'good' : '',
    accent: rule.enabled ? '#3ddc97' : '#65726f',
    body: `Category: ${rule.category}`,
  })).join('')
}

function renderConnections() {
  const list = clearSkeleton('connectionList')
  if (!state.connections.length) {
    list.innerHTML = listRow({
      title: 'No linked providers',
      detail: 'Manual accounts and imports are active.',
      chip: state.health?.masterKeyConfigured ? 'vault ready' : 'needs key',
      tone: state.health?.masterKeyConfigured ? 'good' : 'warn',
    })
  } else {
    list.innerHTML = state.connections.map((conn) => listRow({
      title: conn.displayName,
      detail: `${conn.provider} | ${conn.status}`,
      chip: conn.hasCursor ? 'cursor' : 'new',
      tone: conn.status === 'active' ? 'good' : 'warn',
    })).join('')
  }

  const provider = clearSkeleton('providerPanel')
  provider.innerHTML = [
    listRow({
      title: 'Plaid',
      detail: state.health?.plaidConfigured ? 'Configured' : 'Keys missing',
      chip: state.health?.plaidConfigured ? 'ready' : 'local',
      tone: state.health?.plaidConfigured ? 'good' : 'warn',
    }),
    listRow({
      title: 'Apple Card',
      detail: 'CSV import lane',
      chip: 'import',
      tone: 'good',
    }),
    listRow({
      title: 'SQLite',
      detail: state.health?.storage || 'Local database',
      chip: 'local',
      tone: 'good',
    }),
  ].join('')
}

function renderVaultState() {
  setText('vaultState', state.health?.masterKeyConfigured ? 'Vault ready' : 'Vault needs key')
  setText('vaultDetail', state.summary?.latestTransactionDate ? `Updated ${state.summary.latestTransactionDate}` : 'Local SQLite')
}

function render() {
  renderVaultState()
  renderOverview()
  renderTransactions()
  renderBudgets()
  renderCashflow()
  renderSubscriptions()
  renderAccounts()
  renderDocuments()
  renderTaxes()
  renderAutomation()
  renderConnections()
}

async function load({ quiet = false } = {}) {
  try {
    const [health, summary, accounts, connections, transactions, actions, cashflow, documents, taxes, budgets, rules, history, subscriptions, categories] =
      await Promise.all([
        get('/health'),
        get('/api/summary'),
        get('/api/accounts'),
        get('/api/connections'),
        get('/api/transactions?limit=500'),
        get('/api/action-queue'),
        get('/api/cashflow'),
        get('/api/documents'),
        get('/api/taxes'),
        get('/api/budgets'),
        get('/api/rules'),
        get(`/api/history?range=${encodeURIComponent(state.historyRange)}`),
        get('/api/subscriptions'),
        get('/api/categories'),
      ])
    Object.assign(state, { health, summary, accounts, connections, transactions, actions, cashflow, documents, taxes, budgets, rules, history, subscriptions, categories })
    render()
  } catch (err) {
    if (!quiet) toast(`Backend not ready: ${err.message}`, 'error')
  }
}

async function refreshHistory() {
  state.history = await get(`/api/history?range=${encodeURIComponent(state.historyRange)}`)
  renderOverview()
}

function showView(id) {
  state.view = id
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === id))
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === id
    button.classList.toggle('active', active)
    if (button.classList.contains('nav-button')) button.setAttribute('aria-current', active ? 'page' : 'false')
  })
  const [eyebrow, title] = viewMeta[id] || viewMeta.overview
  setText('viewEyebrow', eyebrow)
  setText('viewTitle', title)
  $('main').focus({ preventScroll: true })
}

function openDialog(id) {
  const dialog = $(id)
  if (dialog && !dialog.open) dialog.showModal()
}

function closeDialogFromButton(button) {
  const dialog = button.closest('dialog')
  if (dialog) dialog.close()
}

function bindEvents() {
  document.addEventListener('click', async (event) => {
    const viewButton = event.target.closest('[data-view]')
    if (viewButton) {
      showView(viewButton.dataset.view)
      return
    }

    const closeButton = event.target.closest('button[value="cancel"]')
    if (closeButton) {
      event.preventDefault()
      closeDialogFromButton(closeButton)
      return
    }

    const rangeButton = event.target.closest('#historyRanges button')
    if (rangeButton) {
      state.historyRange = rangeButton.dataset.range
      await refreshHistory()
      return
    }

    const sortButton = event.target.closest('[data-sort]')
    if (sortButton) {
      const key = sortButton.dataset.sort
      state.txSort = {
        key,
        dir: state.txSort.key === key && state.txSort.dir === 'desc' ? 'asc' : 'desc',
      }
      renderTransactions()
      return
    }

    if (event.target.closest('#addAccountBtn')) openDialog('accountDialog')
    if (event.target.closest('#appleImportBtn')) openDialog('appleDialog')
    if (event.target.closest('#addBudgetBtn')) openDialog('budgetDialog')
    if (event.target.closest('#addRuleBtn')) openDialog('ruleDialog')

    if (event.target.closest('#syncBtn')) {
      try {
        const res = await post('/api/sync', {})
        toast(res.results?.length ? 'Sync completed.' : 'No linked providers to sync.')
        await load({ quiet: true })
      } catch (err) {
        toast(err.message, 'error')
      }
    }

    if (event.target.closest('#runRulesBtn')) {
      try {
        const res = await post('/api/rules/run', {})
        toast(`Updated ${res.updated} transactions.`)
        await load({ quiet: true })
      } catch (err) {
        toast(err.message, 'error')
      }
    }
  })

  document.addEventListener('input', (event) => {
    if (event.target.id === 'txSearch') {
      state.txSearch = event.target.value
      renderTransactions()
    }
  })

  document.addEventListener('change', async (event) => {
    if (event.target.id === 'categoryFilter') {
      state.txCategory = event.target.value
      renderTransactions()
      return
    }
    if (event.target.id === 'documentYear') {
      state.documentYear = Number(event.target.value)
      renderDocuments()
      return
    }
    if (event.target.id === 'taxYear') {
      state.taxYear = Number(event.target.value)
      renderTaxes()
      return
    }
    if (event.target.classList.contains('category-select')) {
      const row = event.target.closest('tr')
      const always = row?.querySelector('.always-check')?.checked || false
      try {
        await patch(`/api/transactions/${encodeURIComponent(event.target.dataset.id)}`, {
          category: event.target.value,
          always,
        })
        toast(always ? 'Category rule saved.' : 'Category updated.')
        await load({ quiet: true })
      } catch (err) {
        toast(err.message, 'error')
      }
    }
  })

  $('accountForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    try {
      await post('/api/manual/accounts', {
        name: form.get('name'),
        institution: form.get('institution'),
        kind: form.get('kind'),
        balance: Number(form.get('balance') || 0),
        notes: form.get('notes'),
      })
      formEl.reset()
      $('accountDialog').close()
      toast('Account saved.')
      await load({ quiet: true })
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  $('appleForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    try {
      const res = await post('/api/import/apple-card', { csv: form.get('csv') })
      formEl.reset()
      $('appleDialog').close()
      toast(`Imported ${res.imported} transactions.`)
      await load({ quiet: true })
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  $('budgetForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    try {
      await post('/api/budgets', {
        category: form.get('category'),
        monthlyLimit: Number(form.get('monthlyLimit') || 0),
        color: form.get('color'),
        notes: form.get('notes'),
      })
      formEl.reset()
      $('budgetDialog').close()
      toast('Budget saved.')
      await load({ quiet: true })
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  $('ruleForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    const form = new FormData(formEl)
    try {
      await post('/api/rules', {
        pattern: form.get('pattern'),
        category: form.get('category'),
      })
      formEl.reset()
      $('ruleDialog').close()
      toast('Rule saved.')
      await load({ quiet: true })
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  let goMode = false
  let goTimer = null
  const goMap = {
    o: 'overview',
    t: 'transactions',
    b: 'budgets',
    c: 'cashflow',
    s: 'subscriptions',
    a: 'accounts',
    d: 'documents',
    x: 'taxes',
    r: 'automation',
    n: 'connections',
  }
  document.addEventListener('keydown', (event) => {
    const tag = event.target.tagName
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === '/' && !editing) {
      event.preventDefault()
      showView('transactions')
      window.setTimeout(() => $('txSearch')?.focus(), 0)
      return
    }
    if (editing) return
    if (goMode) {
      const view = goMap[event.key.toLowerCase()]
      goMode = false
      window.clearTimeout(goTimer)
      if (view) {
        event.preventDefault()
        showView(view)
      }
      return
    }
    if (event.key.toLowerCase() === 'g') {
      goMode = true
      goTimer = window.setTimeout(() => { goMode = false }, 1200)
    }
  })
}

bindEvents()
showView('overview')
load()
