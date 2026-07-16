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
  insights: null,
  categories: [],
  view: 'overview',
  historyRange: '1Y',
  txSearch: '',
  txCategory: 'all',
  txSort: { key: 'date', dir: 'desc' },
  documentYear: null,
  taxYear: null,
  pendingDeleteBudget: null,
  pendingDeleteRule: null,
  pendingUnlinkConnection: null,
  plaidLinking: false,
  providers: [],
  providerChecks: {},
  providerChecking: null,
  directLinking: null,
}

const checkSvg = '<svg viewBox="0 0 24 24"><path d="m5 13 4 4 10-11" /></svg>'

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

function cssVar(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
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

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// '2026-04' -> 'Apr'; anything unparseable falls through untouched.
function monthShort(ym) {
  const n = Number(String(ym || '').slice(5, 7))
  return MONTH_SHORT[n - 1] || String(ym || '')
}

// ['2026-04','2026-05','2026-06'] -> 'Apr–Jun' (order-insensitive).
function monthRangeLabel(months) {
  if (!Array.isArray(months) || !months.length) return ''
  const sorted = months.map(String).slice().sort()
  const first = monthShort(sorted[0])
  const last = monthShort(sorted.at(-1))
  return first === last ? first : `${first}–${last}`
}

// Fractional rate (0.298) -> '29.8%'; null/NaN (zero-income window) -> 'n/a'.
function fmtRate(rate, digits = 1) {
  const n = Number(rate)
  if (rate == null || !Number.isFinite(n)) return 'n/a'
  return `${(n * 100).toFixed(digits)}%`
}

function accountNameById(accountId) {
  if (!accountId) return ''
  const account = state.accounts.find((a) => a.id === accountId)
  return account?.name || ''
}

function humanizeTime(value) {
  if (!value) return 'never'
  const then = new Date(value)
  if (Number.isNaN(then.getTime())) return String(value)
  const diff = Date.now() - then.getTime()
  const mins = Math.round(Math.abs(diff) / 60000)
  const suffix = diff < 0 ? 'from now' : 'ago'
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ${suffix}`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ${suffix}`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ${suffix}`
  return then.toISOString().slice(0, 10)
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

function del(path) {
  return request(path, { method: 'DELETE' })
}

function toast(message, tone = 'info', duration = 3000) {
  const stack = $('toastStack')
  const item = document.createElement('div')
  const classes = ['toast']
  if (tone === 'error') classes.push('error')
  if (tone === 'success') classes.push('success')
  item.className = classes.join(' ')
  item.textContent = message
  stack.append(item)

  // Trigger animation
  requestAnimationFrame(() => {
    item.classList.add('show')
  })

  // Remove after delay
  const timeoutId = window.setTimeout(() => {
    item.classList.remove('show')
    window.setTimeout(() => item.remove(), 200)
  }, duration)

  return { item, timeoutId }
}

function emptyState(icon, title, message, ctaHtml = '') {
  return `
    <div class="empty-state">
      <div class="empty-icon">${escapeHtml(icon)}</div>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(message)}</p>
      ${ctaHtml ? `<div class="empty-cta">${ctaHtml}</div>` : ''}
    </div>
  `
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

function financeCard({ title, meta, value, body, chip, tone = '', accent = '#3ddc97', extra = '', className = '' }) {
  return `
    <article class="finance-card${className ? ` ${className}` : ''}" style="border-top: 3px solid ${safeColor(accent)}">
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

function budgetState(percent) {
  const p = Number(percent || 0)
  if (p > 100) return 'over'
  if (p >= 80) return 'near'
  return 'under'
}

function progressBar(percent, options = {}) {
  // Back-compat: a bare string is treated as a fixed fill color (documents view).
  const { state = '', color = '', label = 'Progress' } = typeof options === 'string' ? { color: options } : options
  const value = Math.round(Number(percent || 0))
  const width = Math.max(0, Math.min(100, Number(percent || 0)))
  const styleColor = !state && color ? `;background:${safeColor(color)}` : ''
  const stateClass = state ? ` is-${state}` : ''
  return `<div class="progress-track" role="progressbar" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(label)}"><span class="progress-fill${stateClass}" style="width:${width}%${styleColor}"></span></div>`
}

function lineChart(points) {
  if (!points?.length) return emptyState('📈', 'No history', 'Transactions will appear here')
  const width = 760
  const height = 220
  const pad = 24
  const green = cssVar('--green', '#3ddc97')
  const areaFill = cssVar('--green-soft', 'rgba(61, 220, 151, 0.12)')
  const gridColor = cssVar('--line-soft', '#1b242e')
  const axisColor = cssVar('--faint', '#65726f')
  const values = points.map((p) => Number(p.netWorth || 0))
  const min = Math.min(...values)
  const max = Math.max(...values)
  // Degenerate series: an all-equal series draws a flat baseline centered
  // vertically; a lone point is centered horizontally rather than pinned to x=pad.
  const flat = max === min
  const span = flat ? 1 : max - min
  const single = points.length === 1
  const midY = height / 2
  const xStep = single ? 0 : (width - pad * 2) / (points.length - 1)
  const coords = points.map((point, index) => {
    const x = single ? width / 2 : pad + index * xStep
    const y = flat ? midY : height - pad - ((Number(point.netWorth || 0) - min) / span) * (height - pad * 2)
    return { x, y, point }
  })
  // For a single point draw a short flat baseline so the chart never renders as a bare dot.
  const line = single
    ? `M${pad} ${midY.toFixed(1)} L${(width - pad).toFixed(1)} ${midY.toFixed(1)}`
    : coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaLeft = single ? pad : coords[0].x
  const areaRight = single ? width - pad : coords.at(-1).x
  const baselineY = single ? midY : height - pad
  const area = `${line} L${areaRight.toFixed(1)} ${baselineY.toFixed(1)} L${areaLeft.toFixed(1)} ${baselineY.toFixed(1)} Z`
  const grid = [0.25, 0.5, 0.75].map((t) => {
    const y = pad + t * (height - pad * 2)
    return `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" stroke="${gridColor}" />`
  }).join('')
  const dots = coords.map((p) => `
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${green}">
      <title>${escapeHtml(`${p.point.date}: ${fmtMoney(p.point.netWorth)}`)}</title>
    </circle>
  `).join('')
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Net worth history">
      ${grid}
      <path d="${area}" fill="${areaFill}" stroke="none"></path>
      <path d="${line}" fill="none" stroke="${green}" stroke-width="3"></path>
      ${dots}
      <text x="${pad}" y="${height - 7}" fill="${axisColor}" font-size="12">${escapeHtml(points[0].date)}</text>
      <text x="${width - pad}" y="${height - 7}" fill="${axisColor}" font-size="12" text-anchor="end">${escapeHtml(points.at(-1).date)}</text>
    </svg>
  `
}

function cashflowBars(months) {
  const data = (months || []).slice(-8)
  if (!data.length) return emptyState('💸', 'No cashflow', 'Data will appear as transactions are imported')
  const width = 760
  const height = 360
  const pad = 34
  const green = cssVar('--green', '#3ddc97')
  const violet = cssVar('--violet', '#a78bfa')
  const axisColor = cssVar('--faint', '#6f7d79')
  const legendColor = cssVar('--muted', '#91a09b')
  const gridColor = cssVar('--line', '#25303b')
  const max = Math.max(...data.flatMap((m) => [Number(m.income || 0), Number(m.spending || 0)]), 1)
  const group = (width - pad * 2) / data.length
  const barWidth = Math.min(28, group / 3)
  const bars = data.map((month, index) => {
    const x = pad + index * group + group / 2
    const incomeH = (Number(month.income || 0) / max) * (height - pad * 2)
    const spendH = (Number(month.spending || 0) / max) * (height - pad * 2)
    return `
      <rect x="${x - barWidth - 2}" y="${height - pad - incomeH}" width="${barWidth}" height="${incomeH}" rx="4" fill="${green}">
        <title>${escapeHtml(`${month.month} income ${fmtMoney(month.income)}`)}</title>
      </rect>
      <rect x="${x + 2}" y="${height - pad - spendH}" width="${barWidth}" height="${spendH}" rx="4" fill="${violet}">
        <title>${escapeHtml(`${month.month} spend ${fmtMoney(month.spending)}`)}</title>
      </rect>
      <text x="${x}" y="${height - 10}" fill="${axisColor}" font-size="11" text-anchor="middle">${escapeHtml(month.month.slice(5))}</text>
    `
  }).join('')
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly cashflow">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="${gridColor}" />
      ${bars}
      <text x="${pad}" y="20" fill="${legendColor}" font-size="12">Income</text>
      <circle cx="${pad + 53}" cy="16" r="5" fill="${green}" />
      <text x="${pad + 72}" y="20" fill="${legendColor}" font-size="12">Spend</text>
      <circle cx="${pad + 118}" cy="16" r="5" fill="${violet}" />
    </svg>
  `
}

function donutChart(items) {
  const data = (items || []).filter((item) => item.total > 0).slice(0, 7)
  if (!data.length) return emptyState('🍕', 'No spend', 'Spending patterns will appear here')
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
      <span class="legend-label">${escapeHtml(item.category)}</span>
      <strong>${escapeHtml(fmtMoney(item.total))}</strong>
    </div>
  `).join('')
  const trackColor = cssVar('--surface-3', '#151d27')
  const centerColor = cssVar('--text', '#edf5f2')
  const labelColor = cssVar('--muted', '#91a09b')
  return `
    <div class="donut-layout">
      <svg viewBox="0 0 150 150" role="img" aria-label="Spending by category">
        <circle r="${radius}" cx="75" cy="75" fill="none" stroke="${trackColor}" stroke-width="18"></circle>
        ${circles}
        <text x="75" y="71" text-anchor="middle" fill="${centerColor}" font-size="18" font-weight="800">${escapeHtml(fmtMoney(total))}</text>
        <text x="75" y="91" text-anchor="middle" fill="${labelColor}" font-size="11">spend</text>
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

  // Forecast lives in /api/insights; /api/summary carries an additive copy as a
  // fallback so the stat still fills when one of the two lags the other.
  const forecastCash = state.insights?.forecast?.projectedEndOfMonthCash ?? s.forecastEndOfMonthCash
  if (forecastCash == null || !Number.isFinite(Number(forecastCash))) {
    setText('forecastValue', 'n/a')
  } else {
    setAnimated('forecastValue', forecastCash, (n) => fmtMoney(n))
  }

  // Savings rate lives in /api/insights; /api/summary carries additive
  // savingsRate3m/savingsRate6m copies as a fallback (same pattern as the
  // forecast tile above) so the stat still fills when one feed lags the other.
  const savings = state.insights?.savings
  const three = savings?.threeMonth
  const asRate = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null)
  const rate3 = asRate(three?.rate) ?? asRate(s.savingsRate3m)
  const rate6 = asRate(savings?.sixMonth?.rate) ?? asRate(s.savingsRate6m)
  if (rate3 != null) {
    setAnimated('savingsRateMetric', rate3 * 100, (n) => fmtRate(n / 100))
    const metaParts = []
    if (rate6 != null) metaParts.push(`6m ${fmtRate(rate6)}`)
    // Months list only exists on the insights payload; in summary-fallback
    // mode the meta gracefully degrades to just the 6m figure.
    const range = three ? monthRangeLabel(three.months) : ''
    if (range) metaParts.push(range)
    setText('savingsRateMeta', metaParts.join(' · ') || 'Last 3 months')
  } else {
    setText('savingsRateMetric', 'n/a')
    setText('savingsRateMeta', 'Needs a complete month')
  }

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

  // Use Chart.js for net worth visualization
  if (typeof initNetWorthChart === 'function') {
    initNetWorthChart('netWorthChart', state.history.snapshots, state.historyRange)
  } else {
    clearSkeleton('netWorthChart').innerHTML = lineChart(state.history.snapshots)
  }

  renderActionQueue()
  renderBudgetPulse()
  renderRecentTransactions()
  clearSkeleton('categoryDonut').innerHTML = donutChart(state.history.categories)
}

function renderActionQueue() {
  const target = clearSkeleton('actionQueue')
  if (!state.actions.length) {
    target.innerHTML = emptyState('📋', 'No actions', 'All caught up!')
    return
  }
  target.innerHTML = state.actions.slice(0, 6).map((action) => listRow({
    title: action.title,
    detail: action.detail,
    // Anomalies get a named chip so unusual charges read differently from
    // routine due-date items; tone still follows priority (high = red).
    chip: action.type === 'anomaly' ? 'anomaly' : action.priority,
    tone: action.priority === 'high' ? 'bad' : 'warn',
  })).join('')
}

function renderBudgetPulse() {
  const target = clearSkeleton('budgetPulse')
  if (!state.budgets.length) {
    target.innerHTML = emptyState('💰', 'No budgets', 'Create a budget to start tracking')
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
    target.innerHTML = emptyState('📊', 'No transactions', 'Import CSV or connect a bank to get started')
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

  // Initialize transaction heatmap
  if (typeof initTransactionHeatmap === 'function') {
    initTransactionHeatmap('heatmapContainer', state.transactions)
  }

  const tbody = $('transactionTable')
  const rows = sortedFilteredTransactions()
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5">${emptyState('🔍', 'No transactions', 'No transactions match your filters')}</td></tr>`
    return
  }
  const getCategoryClass = (category) => {
    const cat = String(category || '').toLowerCase()
    if (cat.includes('dining') || cat.includes('restaurant')) return 'category-dining'
    if (cat.includes('grocery') || cat.includes('supermarket')) return 'category-groceries'
    if (cat.includes('transport') || cat.includes('taxi') || cat.includes('gas')) return 'category-transport'
    if (cat.includes('shopping') || cat.includes('retail')) return 'category-shopping'
    if (cat.includes('utility') || cat.includes('phone') || cat.includes('internet')) return 'category-utilities'
    if (cat.includes('subscription') || cat.includes('membership')) return 'category-subscriptions'
    if (cat.includes('entertainment') || cat.includes('movie') || cat.includes('game')) return 'category-entertainment'
    if (cat.includes('health') || cat.includes('medical') || cat.includes('pharmacy')) return 'category-health'
    return ''
  }

  const categoryOptions = (selected) => state.categories.map((category) => (
    `<option value="${escapeHtml(category)}" ${category === selected ? 'selected' : ''}>${escapeHtml(category)}</option>`
  )).join('')

  tbody.innerHTML = rows.map((tx) => {
    const selectedCat = tx.category || 'Uncategorized'
    return `
    <tr class="transaction-row">
      <td data-label="Date">${escapeHtml(tx.date || '')}</td>
      <td data-label="Merchant">
        <strong>${escapeHtml(tx.merchant || tx.description || 'Transaction')}</strong>
        <p>${escapeHtml(tx.description || '')}</p>
      </td>
      <td data-label="Category" class="category-cell">
        <div class="category-editor">
          <select class="category-select" data-id="${escapeHtml(tx.id)}" aria-label="Category for ${escapeHtml(tx.merchant || 'transaction')}">
            ${categoryOptions(selectedCat)}
          </select>
          <label class="inline-check"><input class="always-check" type="checkbox" />Always</label>
        </div>
      </td>
      <td data-label="Source"><span class="chip">${escapeHtml(tx.provider || tx.source || '')}</span></td>
      <td data-label="Amount" class="${amountClass(tx.amount)} number">${escapeHtml(fmtAmount(tx.amount))}</td>
    </tr>
  `
  }).join('')
}

function renderBudgets() {
  // Initialize budget chart
  if (typeof initBudgetChart === 'function') {
    initBudgetChart('budgetChart', state.budgets)
  }

  const target = clearSkeleton('budgetGrid')
  if (!state.budgets.length) {
    target.innerHTML = emptyState('💰', 'No budgets', 'Click "Budget" to create your first budget')
    return
  }
  target.innerHTML = state.budgets.map((budget) => {
    const over = budget.remaining != null && budget.remaining < 0
    const merchants = budget.topMerchants?.length
      ? `<div class="merchant-list">${budget.topMerchants.map((m) => `<span class="chip">${escapeHtml(`${m.merchant} ${fmtMoney(m.total)}`)}</span>`).join('')}</div>`
      : ''
    const arming = state.pendingDeleteBudget === budget.id
    const actions = `<div class="card-actions">
      <button class="ghost-button budget-edit" data-id="${escapeHtml(budget.id)}">Edit</button>
      <button class="ghost-button danger budget-delete${arming ? ' is-arming' : ''}" data-id="${escapeHtml(budget.id)}">${arming ? 'Confirm delete' : 'Delete'}</button>
    </div>`
    return financeCard({
      title: budget.category,
      meta: budget.month,
      value: `${Math.round(budget.percent)}%`,
      chip: over ? 'over' : budget.percent > 80 ? 'watch' : 'ok',
      tone: over ? 'bad' : budget.percent > 80 ? 'warn' : 'good',
      accent: budget.color,
      body: `${fmtMoney(budget.spent)} of ${fmtMoney(budget.monthlyLimit)} | ${budget.deltaFromPrevious >= 0 ? '+' : ''}${fmtMoney(budget.deltaFromPrevious)} vs prior month`,
      extra: `${progressBar(budget.percent, { state: budgetState(budget.percent), label: `${budget.category} budget usage` })}${merchants}${actions}`,
    })
  }).join('')
}

function renderCashflowForecast() {
  const target = clearSkeleton('cashflowForecast')
  if (!target) return
  const f = state.insights?.forecast
  if (!f || f.projectedEndOfMonthCash == null || !Number.isFinite(Number(f.projectedEndOfMonthCash))) {
    target.innerHTML = emptyState('🔮', 'No forecast yet', 'Projections appear once a complete month of history exists')
    return
  }
  const projected = Number(f.projectedEndOfMonthCash)
  const net = Number(f.projectedNet || 0)
  const baselineRange = Array.isArray(f.baselineMonths) ? monthRangeLabel(f.baselineMonths) : ''
  // baselineMonths is an array of month keys, never a count — when the range
  // label is unavailable, fall back to the constant baseline description.
  const note = baselineRange
    ? `Based on ${baselineRange} average`
    : 'Based on 3-month average'
  target.innerHTML = `
    <div class="forecast-hero">
      <span class="label">${escapeHtml(`Projected cash · end of ${monthShort(f.month)}`)}</span>
      <strong class="${projected < 0 ? 'neg' : ''}">${escapeHtml(fmtMoney(projected, true))}</strong>
      <p>${escapeHtml(`Cash today ${fmtMoney(f.cashNow, true)} · day ${f.daysElapsed} of ${f.daysInMonth}`)}</p>
    </div>
    <div class="forecast-grid">
      <div>
        <span>Projected income</span>
        <strong>${escapeHtml(fmtMoney(f.projectedIncome))}</strong>
        <small>${escapeHtml(`MTD ${fmtMoney(f.incomeMtd)} · avg ${fmtMoney(f.avgIncome)}`)}</small>
      </div>
      <div>
        <span>Projected spend</span>
        <strong>${escapeHtml(fmtMoney(f.projectedSpending))}</strong>
        <small>${escapeHtml(`MTD ${fmtMoney(f.spendMtd)} · avg ${fmtMoney(f.avgSpend)}`)}</small>
      </div>
      <div>
        <span>Projected net</span>
        <strong class="${net < 0 ? 'neg' : 'pos'}">${escapeHtml(fmtMoney(net))}</strong>
        <small>income minus spend</small>
      </div>
    </div>
    <p class="forecast-note">${escapeHtml(note)}</p>
  `
}

function renderCashflow() {
  // Use Chart.js for cashflow visualization
  if (typeof initCashflowChart === 'function') {
    initCashflowChart('cashflowChart', state.cashflow)
  } else {
    clearSkeleton('cashflowChart').innerHTML = cashflowBars(state.cashflow.slice().reverse())
  }

  renderCashflowForecast()

  const target = clearSkeleton('cashflowStats')
  if (!state.cashflow.length) {
    target.innerHTML = emptyState('📊', 'No cashflow', 'Import transactions to see your cashflow')
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
  // Initialize subscription chart
  if (typeof initSubscriptionChart === 'function') {
    initSubscriptionChart('subscriptionChart', state.subscriptions)
  }

  const target = $('subscriptionGrid')
  const summary = $('subscriptionSummary')
  if (!state.subscriptions.length) {
    if (summary) summary.innerHTML = ''
    target.innerHTML = emptyState('🔄', 'No subscriptions', 'Recurring charges will appear here')
    return
  }
  if (summary) {
    const total = state.subscriptions.reduce((sum, item) => sum + Number(item.monthlyCost || 0), 0)
    summary.innerHTML = `
      <span class="label">Est. monthly</span>
      <strong>${escapeHtml(fmtMoney(total, true))}</strong>
      <span class="sub-annual">${escapeHtml(`${fmtMoney(total * 12, true)}/yr`)}</span>
      <span class="chip">${state.subscriptions.length} recurring</span>
    `
  }
  target.innerHTML = state.subscriptions.map((item) => {
    const increase = item.priceIncrease
    const badges = [`<span class="chip">${escapeHtml(item.cadence || 'recurring')}</span>`]
    if (increase && Number(increase.delta) > 0) {
      badges.push(`<span class="chip warn price-up">${escapeHtml(`↑ ${fmtMoney(increase.delta, true)} since ${increase.effectiveDate || 'recently'}`)}</span>`)
    }
    // Two rows can share a merchant (same subscription on two cards) — the
    // account name is what tells them apart.
    const accountName = accountNameById(item.accountId)
    const bodyParts = []
    if (accountName) bodyParts.push(accountName)
    bodyParts.push(`${item.chargeCount} charges`)
    bodyParts.push(`last ${item.lastCharged || 'unknown'}`)
    if (item.nextExpectedDate) bodyParts.push(`next ~${item.nextExpectedDate}`)
    return financeCard({
      title: item.merchant,
      meta: item.category || 'Recurring',
      value: fmtMoney(item.monthlyCost, true),
      chip: `${Math.round(item.confidence * 100)}%`,
      tone: item.confidence > 0.9 ? 'good' : 'warn',
      accent: increase ? '#f59e0b' : item.category === 'Subscriptions' ? '#a78bfa' : '#38bdf8',
      body: bodyParts.join(' | '),
      extra: `<div class="sub-badges">${badges.join('')}</div>`,
    })
  }).join('')
}

function renderAccounts() {
  // Initialize account chart
  if (typeof initAccountChart === 'function') {
    initAccountChart('accountChart', state.accounts)
  }

  const target = $('accountGrid')
  if (!state.accounts.length) {
    target.innerHTML = emptyState('🏦', 'No accounts', 'Connect a bank or add a manual account')
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
    target.innerHTML = emptyState('📄', 'No documents', 'Upload documents for this year')
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
    taskTarget.innerHTML = emptyState('✅', 'All set', 'No tax tasks for this year')
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
    : emptyState('🏷️', 'No deductions', 'Tag transactions to claim deductions')
}

function renderAutomation() {
  const target = $('ruleGrid')
  if (!state.rules.length) {
    target.innerHTML = emptyState('⚙️', 'No rules', 'Create a rule to auto-categorize transactions')
    return
  }
  target.innerHTML = state.rules.map((rule) => {
    const arming = state.pendingDeleteRule === rule.id
    const actions = `<div class="card-actions">
      <button class="ghost-button rule-toggle" data-id="${escapeHtml(rule.id)}">${rule.enabled ? 'Disable' : 'Enable'}</button>
      <button class="ghost-button danger rule-delete${arming ? ' is-arming' : ''}" data-id="${escapeHtml(rule.id)}">${arming ? 'Confirm delete' : 'Delete'}</button>
    </div>`
    return financeCard({
      title: rule.pattern,
      meta: rule.target,
      chip: rule.enabled ? 'enabled' : 'off',
      tone: rule.enabled ? 'good' : '',
      accent: rule.enabled ? '#3ddc97' : '#65726f',
      body: `Category: ${rule.category}`,
      className: rule.enabled ? '' : 'is-disabled',
      extra: actions,
    })
  }).join('')
}

function onboardingStep(index, done, title, doneText, todoText) {
  return `
    <li class="onboard-step${done ? ' is-done' : ''}">
      <span class="onboard-mark" aria-hidden="true">${done ? checkSvg : String(index)}</span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(done ? doneText : todoText)}</p>
      </div>
    </li>
  `
}

function renderOnboarding() {
  const target = $('onboardingCard')
  if (!target) return
  const vaultOk = !!state.health?.masterKeyConfigured
  const plaidOk = !!state.health?.plaidConfigured
  const bankOk = state.connections.length > 0
  const done = [vaultOk, plaidOk, bankOk].filter(Boolean).length
  // Plaid keys are the optional credentialed path: once the vault is set and a
  // bank is connected (Demo Bank counts), onboarding is complete. Without this,
  // a demo-only user is pinned at 2/3 forever with no actionable CTA.
  if (done === 3 || (vaultOk && bankOk)) {
    target.hidden = true
    target.innerHTML = ''
    return
  }
  target.hidden = false
  const direct = firstDirectProvider()
  const directLabel = direct?.label || 'Demo Bank'
  const directConnected = direct ? isProviderConnected(direct.id) : false
  const directBusy = direct ? state.directLinking === direct.id : false
  const plaidBtn = plaidOk
    ? `<button class="primary-button connect-trigger" id="onboardConnectBtn">
        <svg viewBox="0 0 24 24"><path d="M3 10h18M6 6h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" /><path d="M15 15h2" /></svg>
        <span>Connect a bank</span>
      </button>`
    : ''
  const demoBtn = direct && !directConnected
    ? `<button class="${plaidOk ? 'secondary-button' : 'primary-button'} provider-connect" id="onboardDemoBtn" data-provider="${escapeHtml(direct.id)}"${directBusy ? ' disabled' : ''}>${directBusy ? 'Connecting…' : `Try ${escapeHtml(directLabel)}`}</button>`
    : ''
  const hint = plaidOk
    ? ''
    : `<p class="onboard-hint">Plaid linking unlocks once API keys are set on the server. ${escapeHtml(directLabel)} works without keys.</p>`
  const actions = plaidBtn || demoBtn ? `<div class="onboard-actions">${plaidBtn}${demoBtn}</div>` : ''
  const cta = `${actions}${hint}`
  target.innerHTML = `
    <div class="onboard-head">
      <div><span class="label">First run</span><h3>Connect your first bank</h3></div>
      <span class="chip ${done === 2 ? 'warn' : 'bad'}">${done}/3 done</span>
    </div>
    <ol class="onboard-steps">
      ${onboardingStep(1, vaultOk, 'Secure vault',
        'Vault key is set — linked data is encrypted at rest.',
        'Ask your admin to set a master key on the server so linked data is encrypted.')}
      ${onboardingStep(2, plaidOk, 'Bank provider keys',
        'Plaid is configured and ready to link.',
        bankOk
          ? `Optional — a bank is already connected. Add Plaid API keys to link real institutions.`
          : `Optional: add Plaid API keys on the server for real institutions. ${directLabel} works without them.`)}
      ${onboardingStep(3, bankOk, 'Connect a bank',
        'At least one bank is linked. You are all set.',
        `Link an institution with Plaid, or use Try ${directLabel} to explore with seeded data.`)}
    </ol>
    ${cta}
  `
}

function connectionRow(conn) {
  const id = conn.id
  const arming = state.pendingUnlinkConnection === id
  const status = String(conn.status || 'unknown')
  const tone = status === 'active' ? 'good' : status === 'error' ? 'bad' : 'warn'
  const synced = conn.lastSyncedAt ? `Synced ${humanizeTime(conn.lastSyncedAt)}` : 'Not synced yet'
  const provider = conn.provider || 'provider'
  // Old cached rows may lack the resilience fields — treat them as healthy.
  const health = conn.health === 'degraded' || conn.health === 'down' ? conn.health : 'healthy'
  const healthChip = health === 'healthy'
    ? ''
    : `<span class="chip ${health === 'down' ? 'bad' : 'warn'}">${escapeHtml(health)}</span>`
  const failures = Number(conn.consecutiveFailures || 0)
  const healthDetail = health === 'healthy'
    ? ''
    : `<p class="conn-health-detail">${escapeHtml(`${conn.lastErrorClass || 'unknown'} · ${failures} failure${failures === 1 ? '' : 's'} · last sync ${conn.lastSyncedAt ? humanizeTime(conn.lastSyncedAt) : 'never'}`)}</p>`
  const errorChip = conn.lastError
    ? `<span class="chip bad conn-error" title="${escapeHtml(conn.lastError)}">${escapeHtml(conn.lastError)}</span>`
    : ''
  return `
    <div class="conn-row">
      <div class="conn-main">
        <div class="conn-head">
          <strong>${escapeHtml(conn.displayName || provider)}</strong>
          <span class="chip ${tone}">${escapeHtml(status)}</span>
          ${healthChip}
        </div>
        <p>${escapeHtml(`${provider} | ${synced}`)}</p>
        ${healthDetail}
        ${errorChip}
      </div>
      <div class="card-actions conn-actions">
        <button class="ghost-button conn-sync" data-id="${escapeHtml(id)}">Sync</button>
        <button class="ghost-button danger conn-unlink${arming ? ' is-arming' : ''}" data-id="${escapeHtml(id)}">${arming ? 'Confirm unlink' : 'Unlink'}</button>
      </div>
    </div>
  `
}

// Succinct manual-sync summary: "Demo Bank synced · Plaid failed (provider-down)".
function syncResultsToast(results) {
  if (!results?.length) {
    toast('No linked providers to sync.')
    return
  }
  const nameOf = (result) => {
    const conn = state.connections.find((c) => c.id === result.connectionId)
    return conn?.displayName || result.connectionId || 'Connection'
  }
  const failed = results.filter((r) => r.ok === false)
  if (!failed.length) {
    toast('Sync completed.')
    return
  }
  const okText = results.filter((r) => r.ok !== false).map((r) => `${nameOf(r)} synced`).join(' · ')
  // Keep the provider's human error message, but stay one-line-ish: only the
  // first failure carries its message; further failures collapse to "+N more".
  const first = failed[0]
  const firstText = `${nameOf(first)} failed (${first.errorClass || 'unknown'})${first.error ? `: ${first.error}` : ''}`
  const failedText = failed.length > 1 ? `${firstText} +${failed.length - 1} more` : firstText
  toast(okText ? `${okText} · ${failedText}` : failedText, 'error')
}

function firstDirectProvider() {
  return state.providers.find((provider) => provider.linkMode === 'direct') || null
}

function isProviderConnected(providerId) {
  return state.connections.some((conn) => conn.provider === providerId)
}

// Cosmetic copy only — behavior is driven by provider.linkMode.
const DIRECT_PROVIDER_COPY = {
  mock: { chip: 'demo', detail: 'Seeded local institution — no credentials needed.' },
}

function providerBadge(provider) {
  const check = state.providerChecks[provider.id]
  if (check) {
    if (check.ok) return { text: 'Ready', tone: 'good' }
    if (check.configured === false) return { text: 'Not configured', tone: 'warn' }
    return { text: `Error ${check.errorCode || check.error || 'failed'}`, tone: 'bad' }
  }
  return provider.configured
    ? { text: 'Ready', tone: 'good' }
    : { text: 'Not configured', tone: 'warn' }
}

function providerRowHtml(provider) {
  const label = provider.label || provider.id
  if (provider.linkMode === 'direct') {
    const connected = isProviderConnected(provider.id)
    const busy = state.directLinking === provider.id
    const copy = DIRECT_PROVIDER_COPY[provider.id] || { chip: 'direct', detail: 'Links directly — no credentials needed.' }
    const action = connected
      ? '<button class="ghost-button" disabled>Connected</button>'
      : `<button class="ghost-button provider-connect" data-provider="${escapeHtml(provider.id)}"${busy ? ' disabled' : ''}>${busy ? 'Connecting…' : `Connect ${escapeHtml(label)}`}</button>`
    return `
      <div class="conn-row provider-row">
        <div class="conn-main">
          <div class="conn-head">
            <strong>${escapeHtml(label)}</strong>
            <span class="chip">${escapeHtml(copy.chip)}</span>
            ${connected ? '<span class="chip good">connected</span>' : ''}
          </div>
          <p>${escapeHtml(copy.detail)}</p>
        </div>
        <div class="card-actions conn-actions">${action}</div>
      </div>
    `
  }
  const badge = providerBadge(provider)
  const check = state.providerChecks[provider.id]
  const checking = state.providerChecking === provider.id
  const detail = check
    ? check.message || check.errorMessage || check.error || 'Check completed.'
    : provider.configured
      ? 'Credentialed bank linking is ready.'
      : 'Add API keys in backend/.env to enable linking.'
  return `
    <div class="conn-row provider-row">
      <div class="conn-main">
        <div class="conn-head">
          <strong>${escapeHtml(provider.label || provider.id)}</strong>
          <span class="chip ${badge.tone}">${escapeHtml(badge.text)}</span>
        </div>
        <p>${escapeHtml(detail)}</p>
      </div>
      <div class="card-actions conn-actions">
        <button class="ghost-button provider-check" data-provider="${escapeHtml(provider.id)}"${checking ? ' disabled' : ''}>${checking ? 'Checking…' : 'Check'}</button>
      </div>
    </div>
  `
}

function renderProviderPanel() {
  const panel = clearSkeleton('providerPanel')
  if (!panel) return
  if (!state.providers.length) {
    panel.innerHTML = emptyState('🔌', 'No providers', 'The provider registry has not loaded yet')
    return
  }
  panel.innerHTML = state.providers.map(providerRowHtml).join('') + [
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

function renderConnections() {
  renderOnboarding()
  const list = clearSkeleton('connectionList')
  if (!state.connections.length) {
    const direct = firstDirectProvider()
    const cta = direct
      ? `<button class="ghost-button provider-connect" data-provider="${escapeHtml(direct.id)}">Connect ${escapeHtml(direct.label || direct.id)}</button>`
      : ''
    list.innerHTML = emptyState(
      '🏦',
      'No banks linked',
      'Link an institution to sync accounts automatically',
      cta,
    )
  } else {
    list.innerHTML = state.connections.map(connectionRow).join('')
  }
  renderProviderPanel()
}

async function checkProvider(providerId) {
  if (state.providerChecking) return
  const provider = state.providers.find((p) => p.id === providerId)
  const label = provider?.label || providerId
  state.providerChecking = providerId
  renderProviderPanel()
  try {
    const result = await post(`/api/providers/${encodeURIComponent(providerId)}/check`, {})
    state.providerChecks[providerId] = result
    if (result.ok) toast(`${label} check passed.`, 'success')
    else toast(`${label} check failed: ${result.errorMessage || result.message || result.error || 'unknown error'}`, 'error')
  } catch (err) {
    state.providerChecks[providerId] = { ok: false, error: err.message, errorMessage: err.message }
    toast(`${label} check failed: ${err.message}`, 'error')
  } finally {
    state.providerChecking = null
    renderProviderPanel()
  }
}

async function connectDirectProvider(provider) {
  if (!provider || state.directLinking) return
  const label = provider.label || provider.id
  const base = `/api/providers/${encodeURIComponent(provider.id)}`
  state.directLinking = provider.id
  renderConnections()
  try {
    const { link_token: linkToken } = await post(`${base}/link-token`, {})
    if (!linkToken) throw new Error(`No link token returned by the server for ${label}.`)
    const conn = await post(`${base}/exchange-public-token`, { public_token: linkToken, metadata: {} })
    const connectionId = conn?.id
    if (!connectionId) throw new Error(`${label} did not return a connection id.`)
    let added = null
    try {
      const res = await post('/api/sync', { connectionId })
      const mine = res.results?.find((r) => r.connectionId === connectionId)
      if (mine?.ok === false) throw new Error(mine.error || 'Sync failed')
      if (Number.isFinite(mine?.added)) added = mine.added
    } catch (syncErr) {
      state.directLinking = null
      toast(`${label} linked, but the first sync failed: ${syncErr.message}`, 'error')
      await load({ quiet: true })
      return
    }
    state.directLinking = null
    await load({ quiet: true })
    toast(added !== null ? `${label} connected — ${added} transactions synced` : `${label} connected.`, 'success')
  } catch (err) {
    state.directLinking = null
    toast(err.message, 'error')
    renderConnections()
  }
}

function setConnectBusy(busy) {
  state.plaidLinking = busy
  document.querySelectorAll('.connect-trigger').forEach((button) => {
    button.disabled = busy
  })
}

async function connectBank() {
  if (state.plaidLinking) return
  if (!state.health?.plaidConfigured) {
    toast('Plaid keys are not set on the server — try Demo Bank from the Connections panel instead.', 'error')
    return
  }
  if (!window.Plaid || typeof window.Plaid.create !== 'function') {
    toast('Plaid Link could not load. Check your connection and try again.', 'error')
    return
  }
  setConnectBusy(true)
  try {
    const { link_token: linkToken } = await post('/api/providers/plaid/link-token', {})
    if (!linkToken) throw new Error('No link token returned by the server.')
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken, metadata) => {
        try {
          await post('/api/providers/plaid/exchange-public-token', { public_token: publicToken, metadata })
          toast('Bank linked. Pulling in your accounts…')
          try {
            await post('/api/sync', {})
          } catch (syncErr) {
            toast(`Linked, but the first sync failed: ${syncErr.message}`, 'error')
          }
          await load({ quiet: true })
        } catch (err) {
          toast(err.message, 'error')
        } finally {
          setConnectBusy(false)
        }
      },
      onExit: (err) => {
        if (err) {
          toast(`Bank linking stopped: ${err.display_message || err.error_message || 'exited early'}`, 'error')
        }
        setConnectBusy(false)
      },
    })
    handler.open()
  } catch (err) {
    toast(err.message, 'error')
    setConnectBusy(false)
  }
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
    const [health, summary, accounts, connections, transactions, actions, cashflow, documents, taxes, budgets, rules, history, subscriptions, categories, providers, insights] =
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
        get('/api/providers'),
        // Insights is additive — an older backend without /api/insights should
        // degrade to empty states, not take down the whole dashboard load.
        get('/api/insights').catch(() => null),
      ])
    Object.assign(state, { health, summary, accounts, connections, transactions, actions, cashflow, documents, taxes, budgets, rules, history, subscriptions, categories, providers, insights })
    render()
  } catch (err) {
    if (!quiet) toast(`Backend not ready: ${err.message}`, 'error')
  }
}

async function refreshHistory() {
  state.history = await get(`/api/history?range=${encodeURIComponent(state.historyRange)}`)
  renderOverview()
}

function openCategoryMenu(event, txId, currentCategory) {
  event.stopPropagation()
  const menu = $(`menu-${txId}`)
  if (!menu) return

  // Close other menus
  document.querySelectorAll('.category-menu.show').forEach((m) => {
    if (m.id !== `menu-${txId}`) m.classList.remove('show')
  })

  // Toggle this menu
  menu.classList.toggle('show')
}

async function recategorizeTransaction(txId, category, createRule) {
  try {
    const result = await patch(`/api/transactions/${encodeURIComponent(txId)}`, {
      category,
      always: createRule,
    })
    toast(`Category updated to ${category}`, 'success')
    // Close menu
    const menu = $(`menu-${txId}`)
    if (menu) menu.classList.remove('show')
    await load({ quiet: true })
  } catch (err) {
    toast(err.message, 'error')
  }
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

function openKeyboardShortcutsHelp() {
  openDialog('shortcutsDialog')
}

function closeDialogFromButton(button) {
  const dialog = button.closest('dialog')
  if (dialog) dialog.close()
}

function openBudgetDialog(budget) {
  const form = $('budgetForm')
  const titleEl = form.querySelector('.dialog-head h2')
  if (budget) {
    form.dataset.editId = budget.id
    if (titleEl) titleEl.textContent = 'Edit budget'
    form.elements.category.value = budget.category || ''
    form.elements.monthlyLimit.value = budget.monthlyLimit ?? ''
    form.elements.color.value = budget.color || '#3ddc97'
    form.elements.notes.value = budget.notes || ''
  } else {
    delete form.dataset.editId
    if (titleEl) titleEl.textContent = 'Add budget'
    form.reset()
  }
  openDialog('budgetDialog')
}

function closeAllMenus() {
  document.querySelectorAll('.category-menu.show').forEach((menu) => {
    menu.classList.remove('show')
  })
}

function bindEvents() {
  document.addEventListener('click', async (event) => {
    // Close category menus when clicking outside
    if (!event.target.closest('.category-cell') && !event.target.closest('.category-menu')) {
      closeAllMenus()
    }

    const moreMenuBtn = event.target.closest('#moreMenuBtn')
    if (moreMenuBtn) {
      const dialog = $('moreMenuDialog')
      if (dialog && !dialog.open) dialog.showModal()
      return
    }

    const closeMoreMenu = event.target.closest('#closeMoreMenu')
    if (closeMoreMenu) {
      event.preventDefault()
      const dialog = $('moreMenuDialog')
      if (dialog) dialog.close()
      return
    }

    const viewButton = event.target.closest('[data-view]')
    if (viewButton) {
      showView(viewButton.dataset.view)
      // Close the more menu modal if it's open
      const moreDialog = $('moreMenuDialog')
      if (moreDialog && moreDialog.open) moreDialog.close()
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

    if (event.target.closest('#helpBtn')) openKeyboardShortcutsHelp()
    if (event.target.closest('#addAccountBtn')) openDialog('accountDialog')
    if (event.target.closest('#appleImportBtn')) openDialog('appleDialog')
    if (event.target.closest('#addBudgetBtn')) openBudgetDialog(null)
    if (event.target.closest('#addRuleBtn')) openDialog('ruleDialog')

    const budgetEdit = event.target.closest('.budget-edit')
    if (budgetEdit) {
      state.pendingDeleteBudget = null
      const budget = state.budgets.find((b) => b.id === budgetEdit.dataset.id)
      if (budget) openBudgetDialog(budget)
      renderBudgets()
      return
    }

    const budgetDelete = event.target.closest('.budget-delete')
    if (budgetDelete) {
      const id = budgetDelete.dataset.id
      if (state.pendingDeleteBudget !== id) {
        state.pendingDeleteBudget = id
        renderBudgets()
        return
      }
      state.pendingDeleteBudget = null
      try {
        await del(`/api/budgets/${encodeURIComponent(id)}`)
        toast('Budget deleted.')
        await load({ quiet: true })
      } catch (err) {
        toast(err.message, 'error')
      }
      return
    }

    const ruleToggle = event.target.closest('.rule-toggle')
    if (ruleToggle) {
      state.pendingDeleteRule = null
      const rule = state.rules.find((r) => r.id === ruleToggle.dataset.id)
      if (rule) {
        try {
          await patch(`/api/rules/${encodeURIComponent(rule.id)}`, { enabled: !rule.enabled })
          toast(rule.enabled ? 'Rule disabled.' : 'Rule enabled.')
          await load({ quiet: true })
        } catch (err) {
          toast(err.message, 'error')
        }
      }
      return
    }

    const ruleDelete = event.target.closest('.rule-delete')
    if (ruleDelete) {
      const id = ruleDelete.dataset.id
      if (state.pendingDeleteRule !== id) {
        state.pendingDeleteRule = id
        renderAutomation()
        return
      }
      state.pendingDeleteRule = null
      try {
        await del(`/api/rules/${encodeURIComponent(id)}`)
        toast('Rule deleted.')
        await load({ quiet: true })
      } catch (err) {
        toast(err.message, 'error')
      }
      return
    }

    const providerCheck = event.target.closest('.provider-check')
    if (providerCheck) {
      await checkProvider(providerCheck.dataset.provider)
      return
    }

    const directConnect = event.target.closest('.provider-connect')
    if (directConnect) {
      const provider = state.providers.find((p) => p.id === directConnect.dataset.provider)
      if (provider) await connectDirectProvider(provider)
      else toast('Provider is not available.', 'error')
      return
    }

    if (event.target.closest('.connect-trigger')) {
      await connectBank()
      return
    }

    const connSync = event.target.closest('.conn-sync')
    if (connSync) {
      state.pendingUnlinkConnection = null
      connSync.disabled = true
      try {
        const res = await post('/api/sync', { connectionId: connSync.dataset.id })
        syncResultsToast(res.results)
        await load({ quiet: true })
      } catch (err) {
        toast(err.message, 'error')
        connSync.disabled = false
      }
      return
    }

    const connUnlink = event.target.closest('.conn-unlink')
    if (connUnlink) {
      const id = connUnlink.dataset.id
      if (state.pendingUnlinkConnection !== id) {
        state.pendingUnlinkConnection = id
        renderConnections()
        return
      }
      state.pendingUnlinkConnection = null
      try {
        await del(`/api/connections/${encodeURIComponent(id)}`)
        toast('Bank unlinked.')
        await load({ quiet: true })
      } catch (err) {
        toast(err.message, 'error')
      }
      return
    }

    const syncBtn = event.target.closest('#syncBtn')
    if (syncBtn) {
      syncBtn.disabled = true
      try {
        const res = await post('/api/sync', {})
        syncResultsToast(res.results)
        await load({ quiet: true })
      } catch (err) {
        toast(err.message, 'error')
      } finally {
        syncBtn.disabled = false
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
    const editId = formEl.dataset.editId
    const payload = {
      category: form.get('category'),
      monthlyLimit: Number(form.get('monthlyLimit') || 0),
      color: form.get('color'),
      notes: form.get('notes'),
    }
    try {
      if (editId) {
        await patch(`/api/budgets/${encodeURIComponent(editId)}`, payload)
      } else {
        await post('/api/budgets', payload)
      }
      delete formEl.dataset.editId
      formEl.reset()
      $('budgetDialog').close()
      toast(editId ? 'Budget updated.' : 'Budget saved.')
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

    // Escape closes menus and dialogs
    if (event.key === 'Escape') {
      closeAllMenus()
      document.querySelectorAll('dialog.show, dialog[open]').forEach((dialog) => {
        if (dialog.open) dialog.close()
      })
      return
    }

    if (event.key === '/' && !editing) {
      event.preventDefault()
      showView('transactions')
      window.setTimeout(() => $('txSearch')?.focus(), 0)
      return
    }
    if (event.key === '?' && !editing) {
      event.preventDefault()
      openKeyboardShortcutsHelp()
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
