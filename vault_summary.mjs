// vault_summary.mjs — read-only monthly summary for the Obsidian vault.
//
// Prints markdown to stdout: net worth, spend by category vs prior month, and
// notable movements. Opens the SQLite DB directly in readOnly mode — it must
// NOT import src/store.mjs (that path runs migrations/seeding, i.e. writes).
// Summaries only: no raw transactions, account numbers/masks, or tokens ever
// appear in the output — the vault syncs to GitHub.
//
// Usage: node vault_summary.mjs [YYYY-MM]   (defaults to the current month)

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB_PATH = path.join(import.meta.dirname, 'backend', 'data', 'finance-os.sqlite')

function monthArg() {
  const arg = process.argv[2]
  if (arg && /^\d{4}-\d{2}$/.test(arg)) return arg
  return new Date().toISOString().slice(0, 7)
}

function priorMonth(month) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function usd(n) {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

const month = monthArg()
const prior = priorMonth(month)
const db = new DatabaseSync(DB_PATH, { readOnly: true })

// Net worth: latest snapshot overall, plus the last snapshot of the prior month
// for the month-over-month delta.
const latest = db
  .prepare(`SELECT date, net_worth, assets, debt, cash FROM snapshots ORDER BY date DESC LIMIT 1`)
  .get()
const priorSnap = db
  .prepare(`SELECT date, net_worth FROM snapshots WHERE date <= ? ORDER BY date DESC LIMIT 1`)
  .get(`${prior}-31`)

// Spend by category, this month vs prior. Positive amounts are treated as spend,
// Income category excluded (matches how the app's insights read the table).
const spendByCategory = (m) =>
  db
    .prepare(
      `SELECT COALESCE(category, 'Uncategorized') AS category,
              ROUND(SUM(amount), 2) AS spend, COUNT(*) AS n
         FROM transactions
        WHERE date LIKE ? AND amount > 0 AND pending = 0
          AND COALESCE(category, '') <> 'Income'
        GROUP BY COALESCE(category, 'Uncategorized')
        ORDER BY spend DESC`
    )
    .all(`${m}%`)

const cur = spendByCategory(month)
const prev = spendByCategory(prior)
const prevMap = new Map(prev.map((r) => [r.category, r.spend]))
const curTotal = cur.reduce((s, r) => s + r.spend, 0)
const prevTotal = prev.reduce((s, r) => s + r.spend, 0)

// Notable movements: biggest category swings vs prior month (>= $50 change).
const movements = []
const seen = new Set()
for (const r of cur) {
  seen.add(r.category)
  const before = prevMap.get(r.category) ?? 0
  const delta = r.spend - before
  if (Math.abs(delta) >= 50) movements.push({ category: r.category, delta, now: r.spend, before })
}
for (const r of prev) {
  if (!seen.has(r.category) && r.spend >= 50) {
    movements.push({ category: r.category, delta: -r.spend, now: 0, before: r.spend })
  }
}
movements.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

// ---- markdown out ----
const lines = []
lines.push(`## Net worth`)
if (latest) {
  lines.push(`- **${usd(latest.net_worth)}** as of ${latest.date} (assets ${usd(latest.assets)} · debt ${usd(latest.debt)} · cash ${usd(latest.cash)})`)
  if (priorSnap && priorSnap.date !== latest.date) {
    const d = latest.net_worth - priorSnap.net_worth
    lines.push(`- ${d >= 0 ? '▲ up' : '▼ down'} ${usd(Math.abs(d))} since ${priorSnap.date}`)
  }
} else {
  lines.push(`- no snapshots recorded yet`)
}
lines.push('')
lines.push(`## Spend by category — ${month} (vs ${prior})`)
lines.push(`| Category | ${month} | ${prior} | Δ |`)
lines.push(`|----------|---------:|---------:|--:|`)
for (const r of cur.slice(0, 12)) {
  const before = prevMap.get(r.category) ?? 0
  const d = r.spend - before
  lines.push(`| ${r.category} | ${usd(r.spend)} | ${usd(before)} | ${d >= 0 ? '+' : ''}${usd(d).replace('$-', '-$')} |`)
}
lines.push(`| **Total** | **${usd(curTotal)}** | **${usd(prevTotal)}** | **${curTotal - prevTotal >= 0 ? '+' : ''}${usd(curTotal - prevTotal)}** |`)
lines.push('')
lines.push(`## Notable movements`)
if (movements.length === 0) {
  lines.push(`- nothing moved more than $50 vs ${prior}`)
} else {
  for (const m2 of movements.slice(0, 6)) {
    lines.push(`- **${m2.category}** ${m2.delta >= 0 ? 'up' : 'down'} ${usd(Math.abs(m2.delta))} (${usd(m2.before)} → ${usd(m2.now)})`)
  }
}

process.stdout.write(lines.join('\n') + '\n')
db.close()
