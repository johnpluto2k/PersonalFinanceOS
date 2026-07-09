// Chart.js initialization and chart functions
// All charts use CSS variables for colors and animations

// Get CSS variable value
function getChartColor(varName, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value || fallback
}

// Chart color palette from CSS
const chartColorPalette = {
  accent: getChartColor('--accent', '#3ddc97'),
  positive: getChartColor('--semantic-positive', '#3ddc97'),
  negative: getChartColor('--semantic-negative', '#ff4545'),
  warning: getChartColor('--semantic-warning', '#ffa500'),
  violet: getChartColor('--violet', '#a78bfa'),
  cyan: getChartColor('--cyan', '#38bdf8'),
  text: getChartColor('--text', '#edf5f2'),
  textSecondary: getChartColor('--text-secondary', '#a0a0a0'),
  surface: getChartColor('--surface-3', '#151d27'),
  line: getChartColor('--line', '#25303b'),
}

// Store active charts for cleanup
const activeCharts = new Map()

// Destroy previous chart if it exists
function destroyChart(chartId) {
  if (activeCharts.has(chartId)) {
    activeCharts.get(chartId).destroy()
    activeCharts.delete(chartId)
  }
}

/**
 * Net worth area chart with range selector
 * @param {string} canvasId - Canvas element ID
 * @param {array} data - Array of { date, netWorth } from /api/history
 * @param {string} range - Current range (1M, 3M, 1Y, ALL)
 */
function initNetWorthChart(canvasId, data = [], range = '1Y') {
  destroyChart(canvasId)
  const canvas = document.getElementById(canvasId)
  if (!canvas) return null

  // Prepare data
  const labels = data.map(d => d.date || '')
  const values = data.map(d => Number(d.netWorth || 0))

  if (labels.length === 0) {
    canvas.parentElement.innerHTML = '<div class="empty-state">No history available.</div>'
    return null
  }

  const ctx = canvas.getContext('2d')
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Net Worth',
        data: values,
        borderColor: chartColorPalette.accent,
        backgroundColor: chartColorPalette.accent.replace(')', ', 0.1)').replace('rgb', 'rgba'),
        borderWidth: 2,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: chartColorPalette.accent,
        pointBorderColor: chartColorPalette.accent,
        pointHoverRadius: 5,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: 'rgba(10, 10, 11, 0.9)',
          titleColor: chartColorPalette.accent,
          bodyColor: '#ffffff',
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (context) => {
              const value = context.raw
              return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 })
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            color: chartColorPalette.textSecondary,
            callback: (value) => '$' + (value / 1000).toFixed(0) + 'k',
          },
          grid: {
            color: chartColorPalette.line,
            drawBorder: false,
          },
        },
        x: {
          ticks: {
            color: chartColorPalette.textSecondary,
            maxRotation: 0,
            // Show every 7th label on mobile, more frequently on desktop
            callback: function(value, index) {
              const step = labels.length > 30 ? 7 : 3
              return index % step === 0 ? labels[index] : ''
            },
          },
          grid: {
            display: false,
            drawBorder: false,
          },
        },
      },
      animation: {
        duration: 600,
        easing: 'easeOutQuart',
      },
    },
  })

  activeCharts.set(canvasId, chart)
  return chart
}

/**
 * Budget grouped bar chart (spent vs limit)
 * @param {string} canvasId - Canvas element ID
 * @param {array} data - Array of { category, spent, limit, monthlyLimit }
 */
function initBudgetChart(canvasId, data = []) {
  destroyChart(canvasId)
  const canvas = document.getElementById(canvasId)
  if (!canvas) return null

  // Filter to budgets with data
  const budgets = (data || []).filter(b => b.monthlyLimit > 0).slice(0, 8)

  if (budgets.length === 0) {
    canvas.parentElement.innerHTML = '<div class="empty-state">No budgets yet.</div>'
    return null
  }

  const labels = budgets.map(b => b.category)
  const spentData = budgets.map(b => Number(b.spent || 0))
  const limitData = budgets.map(b => Number(b.monthlyLimit || 0))

  const ctx = canvas.getContext('2d')
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Spent',
          data: spentData,
          backgroundColor: chartColorPalette.accent,
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Limit',
          data: limitData,
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: undefined,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: chartColorPalette.textSecondary,
            padding: 15,
            font: { size: 12 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(10, 10, 11, 0.9)',
          titleColor: chartColorPalette.accent,
          bodyColor: '#ffffff',
          padding: 10,
          displayColors: true,
          callbacks: {
            label: (context) => {
              const value = context.raw
              const spent = spentData[context.dataIndex]
              const limit = limitData[context.dataIndex]
              const percent = limit > 0 ? Math.round((spent / limit) * 100) : 0
              return `${context.dataset.label}: $${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${percent}%)`
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            color: chartColorPalette.textSecondary,
            callback: (value) => '$' + (value / 1000).toFixed(0) + 'k',
          },
          grid: {
            color: chartColorPalette.line,
            drawBorder: false,
          },
        },
        x: {
          ticks: {
            color: chartColorPalette.textSecondary,
          },
          grid: {
            display: false,
            drawBorder: false,
          },
        },
      },
      animation: {
        duration: 600,
        easing: 'easeOutQuart',
      },
    },
  })

  activeCharts.set(canvasId, chart)
  return chart
}

/**
 * Cashflow stacked bar chart with savings rate line overlay
 * @param {string} canvasId - Canvas element ID
 * @param {array} data - Array of { month, income, spending }
 */
function initCashflowChart(canvasId, data = []) {
  destroyChart(canvasId)
  const canvas = document.getElementById(canvasId)
  if (!canvas) return null

  const cashflow = (data || []).slice(-12)

  if (cashflow.length === 0) {
    canvas.parentElement.innerHTML = '<div class="empty-state">No cashflow data yet.</div>'
    return null
  }

  const labels = cashflow.map(m => {
    const date = new Date(m.month + '-01')
    return date.toLocaleString('en-US', { month: 'short' })
  })
  const incomeData = cashflow.map(m => Number(m.income || 0))
  const spendData = cashflow.map(m => Number(m.spending || 0))
  const savingsRate = cashflow.map(m => {
    const income = Number(m.income || 0)
    return income > 0 ? ((income - Number(m.spending || 0)) / income) * 100 : 0
  })

  const ctx = canvas.getContext('2d')
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Income',
          data: incomeData,
          backgroundColor: chartColorPalette.positive,
          stack: 'Stack 0',
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Spending',
          data: spendData.map(v => -v),
          backgroundColor: chartColorPalette.violet,
          stack: 'Stack 0',
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Savings Rate %',
          data: savingsRate,
          type: 'line',
          borderColor: chartColorPalette.cyan,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: chartColorPalette.cyan,
          pointBorderColor: chartColorPalette.cyan,
          yAxisID: 'y1',
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: chartColorPalette.textSecondary,
            padding: 15,
            font: { size: 12 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(10, 10, 11, 0.9)',
          titleColor: chartColorPalette.accent,
          bodyColor: '#ffffff',
          padding: 10,
          displayColors: true,
          callbacks: {
            label: (context) => {
              if (context.dataset.label === 'Savings Rate %') {
                return `Savings Rate: ${context.raw.toFixed(1)}%`
              }
              const value = Math.abs(context.raw)
              return `${context.dataset.label}: $${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            color: chartColorPalette.textSecondary,
            callback: (value) => '$' + (Math.abs(value) / 1000).toFixed(0) + 'k',
          },
          grid: {
            color: chartColorPalette.line,
            drawBorder: false,
          },
        },
        y1: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          max: 100,
          ticks: {
            color: chartColorPalette.cyan,
            callback: (value) => value.toFixed(0) + '%',
          },
          grid: {
            display: false,
            drawBorder: false,
          },
        },
        x: {
          ticks: {
            color: chartColorPalette.textSecondary,
          },
          grid: {
            display: false,
            drawBorder: false,
          },
        },
      },
      animation: {
        duration: 600,
        easing: 'easeOutQuart',
      },
    },
  })

  activeCharts.set(canvasId, chart)
  return chart
}

/**
 * Transaction spending heatmap - 30-day intensity strip
 * @param {string} containerId - Container element ID
 * @param {array} transactions - Array of transaction objects
 */
function initTransactionHeatmap(containerId, transactions = []) {
  const container = document.getElementById(containerId)
  if (!container) return null

  // Group transactions by date and sum spending for last 30 days
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const thirtyDaysAgo = new Date(today)
  thirtyDaysAgo.setDate(today.getDate() - 30)

  const dailySpend = new Map()
  let maxSpend = 0

  for (const tx of transactions) {
    const txDate = new Date(tx.date)
    txDate.setHours(0, 0, 0, 0)
    if (txDate >= thirtyDaysAgo && txDate <= today) {
      const key = txDate.toISOString().split('T')[0]
      const amount = Math.abs(Number(tx.amount || 0))
      const current = dailySpend.get(key) || 0
      dailySpend.set(key, current + amount)
      maxSpend = Math.max(maxSpend, current + amount)
    }
  }

  if (maxSpend === 0) {
    container.innerHTML = ''
    return null
  }

  // Generate HTML for heatmap
  let html = '<div class="heatmap-strip" role="img" aria-label="Daily spending heatmap (last 30 days)">'

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today)
    date.setDate(today.getDate() - i)
    const dateStr = date.toISOString().split('T')[0]
    const spend = dailySpend.get(dateStr) || 0
    const intensity = spend / maxSpend
    const hue = 0 // red
    const saturation = Math.round(intensity * 100)
    const lightness = Math.max(20, 70 - intensity * 50)
    const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`

    html += `<div class="heatmap-day" style="background-color: ${color};" title="${dateStr}: $${spend.toLocaleString('en-US', { maximumFractionDigits: 0 })} spent"></div>`
  }

  html += '</div>'
  container.innerHTML = html
  return null
}

/**
 * Multi-line account balance chart
 * @param {string} canvasId - Canvas element ID
 * @param {array} accounts - Array of account objects
 */
async function initAccountChart(canvasId, accounts = []) {
  destroyChart(canvasId)
  const canvas = document.getElementById(canvasId)
  if (!canvas) return null

  if (!accounts || accounts.length === 0) {
    canvas.parentElement.innerHTML = '<div class="empty-state">No accounts yet.</div>'
    return null
  }

  // Fetch history for each account
  try {
    const histories = await Promise.all(
      accounts.map(acc =>
        fetch(`/api/accounts/${encodeURIComponent(acc.id)}/history?range=1Y`)
          .then(r => r.json())
          .catch(() => ({ snapshots: [] }))
      )
    )

    // Merge all histories by date
    const dateMap = new Map()
    accounts.forEach((acc, idx) => {
      const history = histories[idx]?.snapshots || []
      history.forEach(snapshot => {
        const date = snapshot.date
        if (!dateMap.has(date)) {
          dateMap.set(date, {})
        }
        dateMap.get(date)[acc.id] = Number(snapshot.balance || 0)
      })
    })

    if (dateMap.size === 0) {
      canvas.parentElement.innerHTML = '<div class="empty-state">No account history available.</div>'
      return null
    }

    // Sort dates
    const dates = Array.from(dateMap.keys()).sort()
    const labels = dates

    // Create dataset for each account
    const palette = [
      chartColorPalette.accent,
      chartColorPalette.cyan,
      chartColorPalette.violet,
      chartColorPalette.warning,
      chartColorPalette.positive,
      '#ff6b9d',
      '#38bdf8',
      '#fbbf24',
    ]

    const datasets = accounts.map((acc, idx) => ({
      label: acc.name,
      data: dates.map(date => dateMap.get(date)[acc.id] || null),
      borderColor: palette[idx % palette.length],
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 2,
      pointBackgroundColor: palette[idx % palette.length],
      pointBorderColor: palette[idx % palette.length],
      pointHoverRadius: 5,
      tension: 0.4,
    }))

    const ctx = canvas.getContext('2d')
    const chart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: 'index',
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: chartColorPalette.textSecondary,
              padding: 15,
              font: { size: 11 },
              usePointStyle: true,
            },
          },
          tooltip: {
            backgroundColor: 'rgba(10, 10, 11, 0.9)',
            titleColor: chartColorPalette.accent,
            bodyColor: '#ffffff',
            padding: 10,
            displayColors: true,
            callbacks: {
              label: (context) => {
                const value = context.raw
                if (value === null) return ''
                return `${context.dataset.label}: $${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
              },
            },
          },
        },
        scales: {
          y: {
            ticks: {
              color: chartColorPalette.textSecondary,
              callback: (value) => '$' + (value / 1000).toFixed(0) + 'k',
            },
            grid: {
              color: chartColorPalette.line,
              drawBorder: false,
            },
          },
          x: {
            ticks: {
              color: chartColorPalette.textSecondary,
              maxRotation: 0,
              callback: function(value, index) {
                const step = labels.length > 30 ? 30 : 15
                return index % step === 0 ? labels[index] : ''
              },
            },
            grid: {
              display: false,
              drawBorder: false,
            },
          },
        },
        animation: {
          duration: 600,
          easing: 'easeOutQuart',
        },
      },
    })

    activeCharts.set(canvasId, chart)
    return chart
  } catch (err) {
    console.error('Error loading account history:', err)
    canvas.parentElement.innerHTML = '<div class="empty-state">Could not load account history.</div>'
    return null
  }
}

/**
 * Subscription stacked area chart
 * @param {string} canvasId - Canvas element ID
 * @param {array} subscriptions - Array of subscription objects
 */
function initSubscriptionChart(canvasId, subscriptions = []) {
  destroyChart(canvasId)
  const canvas = document.getElementById(canvasId)
  if (!canvas) return null

  if (!subscriptions || subscriptions.length === 0) {
    canvas.parentElement.innerHTML = '<div class="empty-state">No subscriptions detected.</div>'
    return null
  }

  // Create monthly data: sum of all active subscriptions each month
  const today = new Date()
  const months = []
  for (let i = 11; i >= 0; i--) {
    const date = new Date(today)
    date.setMonth(today.getMonth() - i)
    const month = date.toLocaleString('en-US', { year: '2-digit', month: '2-digit' })
    months.push(month)
  }

  // Estimate subscription costs (assume they're all monthly)
  const totalMonthly = subscriptions.reduce((sum, sub) => sum + Number(sub.monthlyCost || 0), 0)

  // Create a simple series showing estimated recurring cost
  const labels = months
  const data = months.map(() => totalMonthly)

  const ctx = canvas.getContext('2d')
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Monthly Recurring Cost',
        data,
        backgroundColor: chartColorPalette.violet,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: chartColorPalette.textSecondary,
            padding: 15,
            font: { size: 12 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(10, 10, 11, 0.9)',
          titleColor: chartColorPalette.accent,
          bodyColor: '#ffffff',
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (context) => {
              return `$${context.raw.toLocaleString('en-US', { maximumFractionDigits: 0 })} monthly`
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            color: chartColorPalette.textSecondary,
            callback: (value) => '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 }),
          },
          grid: {
            color: chartColorPalette.line,
            drawBorder: false,
          },
        },
        x: {
          ticks: {
            color: chartColorPalette.textSecondary,
          },
          grid: {
            display: false,
            drawBorder: false,
          },
        },
      },
      animation: {
        duration: 600,
        easing: 'easeOutQuart',
      },
    },
  })

  activeCharts.set(canvasId, chart)
  return chart
}

// Export functions for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initNetWorthChart,
    initBudgetChart,
    initCashflowChart,
    initTransactionHeatmap,
    initAccountChart,
    initSubscriptionChart,
    destroyChart,
  }
}
