import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.mjs'

let database

const ASSET_KINDS = ['checking', 'savings', 'cash', 'investment', 'brokerage', 'retirement']
const DEBT_KINDS = ['credit', 'loan', 'student_loan', 'mortgage']
const DEFAULT_CATEGORIES = [
  'Income',
  'Housing',
  'Groceries',
  'Dining',
  'Transport',
  'Subscriptions',
  'Shopping',
  'Utilities',
  'Education',
  'Investment',
  'Health',
  'Travel',
  'Taxes',
  'Uncategorized',
]

function nowIso() {
  return new Date().toISOString()
}

function todayText() {
  return nowIso().slice(0, 10)
}

function json(value, fallback = null) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function stringify(value) {
  return value == null ? null : JSON.stringify(value)
}

function monthText(dateText) {
  return String(dateText || todayText()).slice(0, 7)
}

function addMonths(month, delta) {
  const [year, monthIndex] = String(month).split('-').map(Number)
  const date = new Date(Date.UTC(year, monthIndex - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function addDaysText(dateText, delta) {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

// Deterministic dense weekly net-worth history for the demo dataset.
// Values are fully computed (no Math.random at seed time) so screenshots and
// audits are reproducible. All figures are integers, so net_worth === assets -
// debt holds EXACTLY with zero float drift for every row.
function demoWeeklySnapshots() {
  const start = '2026-01-01'
  const end = '2026-07-06'
  const dates = []
  let step = 0
  let cursor = start
  while (cursor <= end) {
    dates.push(cursor)
    step += 1
    cursor = addDaysText(start, step * 7)
  }
  if (dates[dates.length - 1] !== end) dates.push(end)

  return dates.map((date, i) => {
    // Upward trend with a mild deterministic sine wiggle on each series.
    const assets = 27480 + i * 70 + Math.round(120 * Math.sin(i * 0.9))
    const debt = 7060 - i * 12 + Math.round(40 * Math.sin(i * 1.3))
    const cash = 10350 + i * 90 + Math.round(80 * Math.sin(i * 0.6))
    const netWorth = assets - debt // exact: integers only
    return {
      id: `snapshot_${date.replace(/-/g, '_')}`,
      date,
      netWorth,
      assets,
      debt,
      cash,
    }
  })
}

function db() {
  if (database) return database
  fs.mkdirSync(config.dataDir, { recursive: true })
  database = new DatabaseSync(config.dbPath)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')
  migrate(database)
  seedIfEmpty(database)
  ensureDemoDepth(database)
  return database
}

function migrate(con) {
  con.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_item_id TEXT,
      display_name TEXT NOT NULL,
      cursor TEXT,
      token_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_sync_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      connection_id TEXT,
      name TEXT NOT NULL,
      official_name TEXT,
      institution TEXT,
      mask TEXT,
      kind TEXT NOT NULL,
      subtype TEXT,
      balance REAL NOT NULL DEFAULT 0,
      available_balance REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      import_only INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      raw_json TEXT,
      last_sync_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT,
      date TEXT,
      merchant TEXT,
      description TEXT,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      category TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      reviewed INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS holdings (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      symbol TEXT,
      name TEXT NOT NULL,
      quantity REAL,
      price REAL,
      value REAL NOT NULL DEFAULT 0,
      allocation TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      tax_year INTEGER,
      institution TEXT,
      status TEXT NOT NULL DEFAULT 'needed',
      due_date TEXT,
      location TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tax_tasks (
      id TEXT PRIMARY KEY,
      tax_year INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      due_date TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      net_worth REAL NOT NULL DEFAULT 0,
      assets REAL NOT NULL DEFAULT 0,
      debt REAL NOT NULL DEFAULT 0,
      cash REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL UNIQUE,
      monthly_limit REAL NOT NULL DEFAULT 0,
      color TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'merchant_description',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
    CREATE INDEX IF NOT EXISTS idx_accounts_kind ON accounts(kind);
    CREATE INDEX IF NOT EXISTS idx_documents_tax_year ON documents(tax_year);
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(date);
    CREATE INDEX IF NOT EXISTS idx_budgets_category ON budgets(category);
    CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled);
  `)

  // Bank Connect Phase B1: guarantee the per-connection sync bookkeeping columns
  // exist on pre-existing DB files. CREATE TABLE IF NOT EXISTS above never alters
  // an already-created table, so an older finance-os.sqlite could lack these. The
  // PRAGMA guard makes each ALTER a no-op when the column is present, so this is
  // idempotent and never throws a "duplicate column name" on the current schema.
  ensureColumn(con, 'connections', 'last_sync_at', 'TEXT')
  ensureColumn(con, 'connections', 'last_error', 'TEXT')

  // Rules dedup maintenance. ORDERING IS CRITICAL: collapse duplicate patterns
  // FIRST, then create the UNIQUE guard index. The current live DB may hold
  // duplicate `pattern` rows (e.g. the 7 legacy `qa test cafe` rows); creating a
  // bare UNIQUE INDEX against those would throw and brick startup, so the index
  // must NOT live in the DDL exec above. The DELETE keeps the oldest (lowest
  // rowid) row per pattern and is idempotent — after the first boot there is
  // nothing left to collapse.
  con.exec('DELETE FROM rules WHERE rowid NOT IN (SELECT MIN(rowid) FROM rules GROUP BY pattern)')
  con.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_pattern ON rules(pattern)')

  const created = con.prepare("SELECT value FROM meta WHERE key='created_at'").get()
  if (!created) {
    con.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('created_at', nowIso())
  }
  con.prepare("UPDATE documents SET status='needed' WHERE status='missing'").run()
  con.prepare("UPDATE documents SET status='verified' WHERE status='ready'").run()
  con.prepare("UPDATE transactions SET date='2026-07-04' WHERE source='demo_seed_v2' AND date > '2026-07-05' AND date LIKE '2026-07-%'").run()
  // Purge the superseded v1 demo transactions. `demo_seed_v2` is the canonical
  // demo dataset; the old `demo_seed` rows carry different ids so they never key-
  // collided and were double-counting into cashflow/category rollups. Runs every
  // boot and only targets the exact legacy source, so it is idempotent and never
  // touches demo_seed_v2, real/manual, or Apple CSV import rows.
  con.prepare("DELETE FROM transactions WHERE source = 'demo_seed'").run()

  // One-time reconcile so the EXISTING demo DB surfaces near-cap + over-budget
  // states (the demo_v2_seeded guard means seed-value edits only affect fresh DBs).
  // Gated by its own meta flag AND guarded to only touch demo budget rows whose
  // limit is STILL the original seeded value, so a user-edited budget is never
  // clobbered. Idempotent: after the flag is set it never runs again, and the
  // monthly_limit guard prevents any double-apply.
  const budgetsReconciled = con.prepare("SELECT value FROM meta WHERE key='demo_budgets_v2'").get()
  if (budgetsReconciled?.value !== 'true') {
    const reconcileBudget = con.prepare(`UPDATE budgets SET monthly_limit = ?, updated_at = ?
      WHERE id = ? AND category = ? AND monthly_limit = ?`)
    const budgetStamp = nowIso()
    // Subscriptions: 80 -> 40 (spend ~46 => OVER 100%). Transport: 190 -> 100 (spend ~92 => 80-100% watch).
    reconcileBudget.run(40, budgetStamp, 'budget_subscriptions', 'Subscriptions', 80)
    reconcileBudget.run(100, budgetStamp, 'budget_transport', 'Transport', 190)
    con.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('demo_budgets_v2', 'true')
  }

  // Re-flatten the demo net-worth history to the dense weekly series. Runs on
  // every startup, idempotent and safe against the existing SQLite file. Demo
  // rows can NEVER clobber a real snapshot: we only refresh existing demo rows in
  // place, and only INSERT a demo date when NO row (demo or real) exists for it.
  // A real server_start/transaction_update/apple_import snapshot on a date that
  // coincides with a fixed weekly demo date therefore always survives.
  const weekly = demoWeeklySnapshots()
  const keepDates = weekly.map((s) => s.date)
  const keepPlaceholders = keepDates.map(() => '?').join(', ')
  const nowStamp = nowIso()
  con.exec('BEGIN')
  try {
    // Drop only stale demo history rows (e.g. a prior month-end series) no longer
    // in the weekly set. `source='demo_history'` guard leaves real rows intact.
    con.prepare(`DELETE FROM snapshots WHERE source = 'demo_history' AND date NOT IN (${keepPlaceholders})`).run(...keepDates)
    const refreshDemo = con.prepare(`UPDATE snapshots
      SET net_worth = ?, assets = ?, debt = ?, cash = ?, updated_at = ?
      WHERE date = ? AND source = 'demo_history'`)
    const insertDemoIfAbsent = con.prepare(`INSERT INTO snapshots
      (id, date, net_worth, assets, debt, cash, source, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 'demo_history', ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE date = ?)`)
    for (const s of weekly) {
      refreshDemo.run(s.netWorth, s.assets, s.debt, s.cash, nowStamp, s.date)
      insertDemoIfAbsent.run(s.id, s.date, s.netWorth, s.assets, s.debt, s.cash, nowStamp, nowStamp, s.date)
    }
    con.exec('COMMIT')
  } catch (err) {
    con.exec('ROLLBACK')
    throw err
  }
  con.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2')
}

function ensureColumn(con, table, column, definition) {
  const columns = con.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((c) => c.name === column)) {
    con.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

function countRows(con, table) {
  return con.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
}

function seedIfEmpty(con) {
  if (countRows(con, 'accounts') > 0 || countRows(con, 'transactions') > 0) return
  const created = nowIso()
  const accounts = [
    {
      id: 'manual_checking_primary',
      provider: 'manual',
      name: 'Primary checking',
      institution: 'Demo Bank',
      kind: 'checking',
      balance: 4280.42,
      notes: 'Sample account. Replace with Plaid-linked data.',
    },
    {
      id: 'manual_savings_emergency',
      provider: 'manual',
      name: 'Emergency savings',
      institution: 'Demo Bank',
      kind: 'savings',
      balance: 9200,
      notes: 'Six-month runway target placeholder.',
    },
    {
      id: 'manual_roth_ira',
      provider: 'manual',
      name: 'Roth IRA',
      institution: 'Brokerage',
      kind: 'investment',
      balance: 13750.18,
      notes: 'Demo investment account.',
    },
    {
      id: 'apple_card_manual',
      provider: 'apple',
      name: 'Apple Card',
      institution: 'Apple Card',
      kind: 'credit',
      balance: 618.27,
      importOnly: true,
      notes: 'Import-based until Apple data is connected through exports or a native companion app.',
    },
    {
      id: 'manual_student_loan',
      provider: 'manual',
      name: 'Student loan',
      institution: 'Loan servicer',
      kind: 'student_loan',
      balance: 6800,
      notes: 'Demo liability.',
    },
  ]
  for (const account of accounts) upsertAccount(null, { ...account, createdAt: created, updatedAt: created })
}

function ensureDemoDepth(con) {
  const seeded = con.prepare("SELECT value FROM meta WHERE key='demo_v2_seeded'").get()
  if (seeded?.value === 'true') return

  const created = nowIso()
  const accounts = [
    {
      id: 'manual_checking_primary',
      provider: 'manual',
      name: 'Primary checking',
      institution: 'Demo Bank',
      kind: 'checking',
      balance: 4380.42,
      notes: 'Operating cash and bill pay.',
    },
    {
      id: 'manual_savings_emergency',
      provider: 'manual',
      name: 'Emergency savings',
      institution: 'Demo Bank',
      kind: 'savings',
      balance: 10450,
      notes: 'Emergency fund target: 6 months.',
    },
    {
      id: 'manual_roth_ira',
      provider: 'manual',
      name: 'Roth IRA',
      institution: 'Brokerage',
      kind: 'investment',
      balance: 15180.18,
      notes: 'Long-term retirement account.',
    },
    {
      id: 'apple_card_manual',
      provider: 'apple',
      name: 'Apple Card',
      institution: 'Apple Card',
      kind: 'credit',
      balance: 642.27,
      importOnly: true,
      notes: 'Apple Card uses CSV exports until a native companion exists.',
    },
    {
      id: 'manual_student_loan',
      provider: 'manual',
      name: 'Student loan',
      institution: 'Loan servicer',
      kind: 'student_loan',
      balance: 6650,
      notes: 'Track payoff progress and tax documents.',
    },
  ]
  for (const account of accounts) upsertAccount(null, { ...account, createdAt: created, updatedAt: created })

  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  const monthlyTxs = []
  for (const [index, month] of months.entries()) {
    const day = (value) => {
      const clamped = month === '2026-07' ? Math.min(Number(value), 4) : Number(value)
      return String(clamped).padStart(2, '0')
    }
    const groceryBase = 66 + index * 2
    const diningBase = 15 + (index % 3) * 4
    const shoppingBase = 74 + index * 6
    monthlyTxs.push(
      [`demo_${month}_paycheck_1`, 'manual_checking_primary', `${month}-${day(3)}`, 'Paycheck', 'Part-time payroll deposit', -920.15, 'Income'],
      [`demo_${month}_paycheck_2`, 'manual_checking_primary', `${month}-${day(17)}`, 'Paycheck', 'Part-time payroll deposit', -920.15, 'Income'],
      [`demo_${month}_rent`, 'manual_checking_primary', `${month}-${day(1)}`, 'Rent', 'Monthly rent payment', 980, 'Housing'],
      [`demo_${month}_utilities`, 'manual_checking_primary', `${month}-${day(8)}`, 'City Utilities', 'Power and water bill', 118 + index * 3, 'Utilities'],
      [`demo_${month}_apple`, 'apple_card_manual', `${month}-${day(2)}`, 'Apple Services', 'Apple services bundle', 19.95, 'Subscriptions'],
      [`demo_${month}_spotify`, 'apple_card_manual', `${month}-${day(5)}`, 'Spotify', 'Music subscription', 10.99, 'Subscriptions'],
      [`demo_${month}_netflix`, 'apple_card_manual', `${month}-${day(12)}`, 'Netflix', 'Video subscription', 15.49, 'Subscriptions'],
      [`demo_${month}_groceries_a`, 'apple_card_manual', `${month}-${day(6)}`, "Trader Joe's", 'Groceries', groceryBase, 'Groceries'],
      [`demo_${month}_groceries_b`, 'apple_card_manual', `${month}-${day(19)}`, 'Whole Foods', 'Groceries', groceryBase + 22, 'Groceries'],
      [`demo_${month}_dining_a`, 'apple_card_manual', `${month}-${day(11)}`, 'Chipotle', 'Lunch', diningBase, 'Dining'],
      [`demo_${month}_dining_b`, 'apple_card_manual', `${month}-${day(23)}`, 'Local Coffee', 'Coffee and pastry', diningBase - 6, 'Dining'],
      [`demo_${month}_transport_a`, 'apple_card_manual', `${month}-${day(14)}`, 'Shell', 'Gas', 38 + index * 2, 'Transport'],
      [`demo_${month}_transport_b`, 'manual_checking_primary', `${month}-${day(20)}`, 'Metro Transit', 'Transit pass', 42, 'Transport'],
      [`demo_${month}_amazon`, 'apple_card_manual', `${month}-${day(21)}`, 'Amazon', 'Household supplies', shoppingBase, 'Shopping'],
      [`demo_${month}_books`, 'apple_card_manual', `${month}-${day(25)}`, 'Campus Bookstore', 'Course materials', month === '2026-01' || month === '2026-06' ? 145 : 26, 'Education'],
      [`demo_${month}_roth`, 'manual_roth_ira', `${month}-${day(28)}`, 'Roth contribution', 'Automated contribution', -150, 'Investment'],
    )
  }

  for (const [id, accountId, date, merchant, description, amount, category] of monthlyTxs) {
    upsertTransaction(null, {
      id,
      source: 'demo_seed_v2',
      provider: accountId === 'apple_card_manual' ? 'apple' : 'manual',
      accountId,
      date,
      merchant,
      description,
      amount,
      currency: 'USD',
      category,
      pending: false,
      reviewed: false,
    })
  }

  const docs = [
    ['doc_w2_2026', 'W-2 from employer', 'tax_form', 2026, 'Employer', 'needed', '2027-01-31', null, 'Income form for federal and state filing.'],
    ['doc_1098t_2026', '1098-T tuition statement', 'tax_form', 2026, 'University', 'needed', '2027-01-31', null, 'Used for education credit review.'],
    ['doc_1099int_2026', '1099-INT from savings bank', 'tax_form', 2026, 'Demo Bank', 'received', '2027-01-31', null, 'Verify interest income against bank summary.'],
    ['doc_brokerage_1099_2026', 'Brokerage consolidated 1099', 'tax_form', 2026, 'Brokerage', 'needed', '2027-02-15', null, 'Investment income and sale proceeds.'],
    ['doc_apple_stmt_jun', 'Apple Card June statement', 'statement', 2026, 'Apple Card', 'verified', null, 'Wallet export', 'Statement imported and reconciled.'],
  ]
  const insertDoc = con.prepare(`INSERT OR REPLACE INTO documents
    (id, title, kind, tax_year, institution, status, due_date, location, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const row of docs) insertDoc.run(...row, created, created)

  const tasks = [
    ['tax_2026_income', 2026, 'Confirm all income forms arrived', 'open', '2027-02-15', 'high', 'W-2, 1099-INT, 1099-DIV, brokerage forms.'],
    ['tax_2026_tuition', 2026, 'Check education credit documents', 'open', '2027-02-20', 'normal', 'Verify 1098-T and qualified expenses.'],
    ['tax_2026_apple', 2026, 'Import Apple Card full-year CSV', 'open', '2027-01-10', 'normal', 'Use Wallet or card.apple.com export.'],
    ['tax_2026_q3_estimate', 2026, 'Review Q3 estimated tax need', 'open', '2026-09-15', 'medium', 'Check self-employment or investment income before the due date.'],
    ['tax_2026_deductions', 2026, 'Tag deductible education and work expenses', 'open', '2026-12-15', 'normal', 'Use transaction categories and notes as evidence.'],
  ]
  const insertTask = con.prepare(`INSERT OR REPLACE INTO tax_tasks
    (id, tax_year, title, status, due_date, priority, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const row of tasks) insertTask.run(...row, created, created)

  const budgets = [
    ['budget_groceries', 'Groceries', 470, '#3ddc97', 'Weekly grocery target with room for bulk buys.'],
    ['budget_dining', 'Dining', 220, '#a78bfa', 'Coffee, lunch, and restaurants.'],
    ['budget_transport', 'Transport', 100, '#38bdf8', 'Gas, transit, rideshare.'],
    ['budget_shopping', 'Shopping', 260, '#f59e0b', 'Retail and household supplies.'],
    ['budget_subscriptions', 'Subscriptions', 40, '#ec4899', 'Recurring digital services.'],
    ['budget_education', 'Education', 120, '#f97316', 'Books, courses, supplies.'],
  ]
  const insertBudget = con.prepare(`INSERT OR REPLACE INTO budgets
    (id, category, monthly_limit, color, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (const row of budgets) insertBudget.run(...row, created, created)

  const rules = [
    ['rule_apple_services', 'apple services', 'Subscriptions'],
    ['rule_spotify', 'spotify', 'Subscriptions'],
    ['rule_netflix', 'netflix', 'Subscriptions'],
    ['rule_trader_joes', 'trader joe', 'Groceries'],
    ['rule_whole_foods', 'whole foods', 'Groceries'],
    ['rule_chipotle', 'chipotle', 'Dining'],
    ['rule_shell', 'shell', 'Transport'],
    ['rule_rent', 'rent', 'Housing'],
    ['rule_paycheck', 'paycheck', 'Income'],
    ['rule_amazon', 'amazon', 'Shopping'],
  ]
  const insertRule = con.prepare(`INSERT OR REPLACE INTO rules
    (id, pattern, category, target, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'merchant_description', 1, ?, ?)`)
  for (const row of rules) insertRule.run(...row, created, created)

  // Dense deterministic weekly history (~2026-01-01 -> 2026-07-06). Insert only
  // when no row already exists for the date, so demo figures never clobber a real
  // captured snapshot (migrate() already handles the ongoing reflatten).
  const insertSnapshot = con.prepare(`INSERT INTO snapshots
    (id, date, net_worth, assets, debt, cash, source, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 'demo_history', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE date = ?)`)
  for (const s of demoWeeklySnapshots()) {
    insertSnapshot.run(s.id, s.date, s.netWorth, s.assets, s.debt, s.cash, created, created, s.date)
  }

  con.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('demo_v2_seeded', 'true')
}

function connectionFromRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    providerItemId: row.provider_item_id,
    displayName: row.display_name,
    cursor: row.cursor,
    token: json(row.token_json),
    status: row.status,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function accountFromRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    connectionId: row.connection_id,
    name: row.name,
    officialName: row.official_name,
    institution: row.institution,
    mask: row.mask,
    kind: row.kind,
    subtype: row.subtype,
    balance: Number(row.balance || 0),
    availableBalance: row.available_balance == null ? null : Number(row.available_balance),
    currency: row.currency,
    importOnly: Boolean(row.import_only),
    notes: row.notes,
    raw: json(row.raw_json),
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function transactionFromRow(row) {
  return {
    id: row.id,
    source: row.source,
    provider: row.provider,
    accountId: row.account_id,
    date: row.date,
    merchant: row.merchant,
    description: row.description,
    amount: Number(row.amount || 0),
    currency: row.currency,
    category: row.category,
    pending: Boolean(row.pending),
    reviewed: Boolean(row.reviewed),
    raw: json(row.raw_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function documentFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    taxYear: row.tax_year,
    institution: row.institution,
    status: row.status,
    dueDate: row.due_date,
    location: row.location,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function taxTaskFromRow(row) {
  return {
    id: row.id,
    taxYear: row.tax_year,
    title: row.title,
    status: row.status,
    dueDate: row.due_date,
    priority: row.priority,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function budgetFromRow(row) {
  return {
    id: row.id,
    category: row.category,
    monthlyLimit: Number(row.monthly_limit || 0),
    color: row.color || '#3ddc97',
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function ruleFromRow(row) {
  return {
    id: row.id,
    pattern: row.pattern,
    category: row.category,
    target: row.target,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function snapshotFromRow(row) {
  return {
    id: row.id,
    date: row.date,
    netWorth: Number(row.net_worth || 0),
    assets: Number(row.assets || 0),
    debt: Number(row.debt || 0),
    cash: Number(row.cash || 0),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rawRules() {
  return db().prepare('SELECT * FROM rules WHERE enabled = 1 ORDER BY created_at').all().map(ruleFromRow)
}

function ruleMatches(rule, tx) {
  const haystack = `${tx.merchant || ''} ${tx.description || ''} ${tx.raw?.description || ''}`.toLowerCase()
  return haystack.includes(String(rule.pattern || '').toLowerCase())
}

function categoryFromRules(tx) {
  if (tx.reviewed) return null
  const match = rawRules().find((rule) => ruleMatches(rule, tx))
  return match?.category || null
}

function latestTransactionMonth() {
  const row = db().prepare("SELECT MAX(date) AS latest FROM transactions WHERE date IS NOT NULL AND date != ''").get()
  return monthText(row?.latest || todayText())
}

function balanceSummaryFromSnapshot(snapshot) {
  const assets = snapshot.accounts
    .filter((a) => ASSET_KINDS.includes(a.kind))
    .reduce((sum, a) => sum + Number(a.balance || 0), 0)
  const debt = snapshot.accounts
    .filter((a) => DEBT_KINDS.includes(a.kind))
    .reduce((sum, a) => sum + Math.abs(Number(a.balance || 0)), 0)
  const cash = snapshot.accounts
    .filter((a) => ['checking', 'savings', 'cash'].includes(a.kind))
    .reduce((sum, a) => sum + Number(a.balance || 0), 0)
  return { assets, debt, cash, netWorth: assets - debt }
}

function csvEscape(value) {
  const text = value == null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function readDb() {
  const con = db()
  return {
    version: 2,
    createdAt: con.prepare("SELECT value FROM meta WHERE key='created_at'").get()?.value || null,
    updatedAt: con.prepare("SELECT MAX(updated_at) AS value FROM accounts").get()?.value || null,
    connections: con.prepare('SELECT * FROM connections ORDER BY updated_at DESC').all().map(connectionFromRow),
    accounts: con.prepare('SELECT * FROM accounts ORDER BY kind, institution, name').all().map(accountFromRow),
    transactions: con.prepare('SELECT * FROM transactions ORDER BY date DESC, created_at DESC').all().map(transactionFromRow),
    documents: con.prepare("SELECT * FROM documents ORDER BY COALESCE(due_date, '9999-99-99'), title").all().map(documentFromRow),
    taxTasks: con.prepare("SELECT * FROM tax_tasks ORDER BY COALESCE(due_date, '9999-99-99'), priority DESC").all().map(taxTaskFromRow),
    syncEvents: con.prepare('SELECT * FROM sync_events ORDER BY created_at DESC LIMIT 100').all().map((r) => ({
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      payload: json(r.payload_json, {}),
      createdAt: r.created_at,
    })),
  }
}

export function writeDb(snapshot) {
  if (!snapshot) return readDb()
  const con = db()
  for (const connection of snapshot.connections || []) upsertConnection(connection)
  for (const account of snapshot.accounts || []) upsertAccount(null, account)
  for (const tx of snapshot.transactions || []) upsertTransaction(null, tx)
  for (const event of snapshot.syncEvents || []) addSyncEvent(event)
  con.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('updated_at', nowIso())
  return readDb()
}

export function upsertConnection(connection) {
  const con = db()
  const now = nowIso()
  con.prepare(`INSERT INTO connections
    (id, provider, provider_item_id, display_name, cursor, token_json, status, last_sync_at, last_error, created_at, updated_at)
    VALUES (@id, @provider, @providerItemId, @displayName, @cursor, @tokenJson, @status, @lastSyncAt, @lastError, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      provider=excluded.provider,
      provider_item_id=excluded.provider_item_id,
      display_name=excluded.display_name,
      cursor=excluded.cursor,
      token_json=excluded.token_json,
      status=excluded.status,
      last_sync_at=excluded.last_sync_at,
      last_error=excluded.last_error,
      updated_at=excluded.updated_at`).run({
    id: connection.id,
    provider: connection.provider,
    providerItemId: connection.providerItemId || null,
    displayName: connection.displayName || 'Linked institution',
    cursor: connection.cursor || null,
    tokenJson: stringify(connection.token),
    status: connection.status || 'active',
    lastSyncAt: connection.lastSyncAt || connection.last_sync_at || null,
    lastError: connection.lastError || connection.last_error || null,
    createdAt: connection.createdAt || now,
    updatedAt: now,
  })
}

// Unlink a provider connection: remove the connection row plus ONLY the accounts
// and transactions that belong to it. Scoping is by accounts.connection_id, which
// is set exclusively for provider-linked accounts (Plaid). Manual accounts and the
// Apple Card import account carry connection_id = NULL, so their rows — and every
// transaction whose account_id points at them — are never touched. Transactions are
// deleted by account_id membership (precise) rather than a broad provider match, so
// nothing outside this connection's own accounts is affected. Runs in a single short
// transaction so the delete is all-or-nothing.
export function deleteConnection(id) {
  const con = db()
  const connection = con.prepare('SELECT * FROM connections WHERE id = ?').get(id)
  if (!connection) {
    const err = new Error('connection not found')
    err.status = 404
    throw err
  }
  const accountIds = con.prepare('SELECT id FROM accounts WHERE connection_id = ?').all(id).map((r) => r.id)
  con.exec('BEGIN')
  try {
    let transactionsRemoved = 0
    if (accountIds.length) {
      const placeholders = accountIds.map(() => '?').join(', ')
      transactionsRemoved = con.prepare(`DELETE FROM transactions WHERE account_id IN (${placeholders})`).run(...accountIds).changes
    }
    const accountsRemoved = con.prepare('DELETE FROM accounts WHERE connection_id = ?').run(id).changes
    con.prepare('DELETE FROM connections WHERE id = ?').run(id)
    con.exec('COMMIT')
    return { removed: true, id, accountsRemoved, transactionsRemoved }
  } catch (err) {
    con.exec('ROLLBACK')
    throw err
  }
}

export function upsertAccount(snapshot, account) {
  const con = db()
  const now = nowIso()
  con.prepare(`INSERT INTO accounts
    (id, provider, connection_id, name, official_name, institution, mask, kind, subtype, balance,
     available_balance, currency, import_only, notes, raw_json, last_sync_at, created_at, updated_at)
    VALUES (@id, @provider, @connectionId, @name, @officialName, @institution, @mask, @kind, @subtype, @balance,
     @availableBalance, @currency, @importOnly, @notes, @rawJson, @lastSyncAt, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      provider=excluded.provider,
      connection_id=excluded.connection_id,
      name=excluded.name,
      official_name=excluded.official_name,
      institution=excluded.institution,
      mask=excluded.mask,
      kind=excluded.kind,
      subtype=excluded.subtype,
      balance=excluded.balance,
      available_balance=excluded.available_balance,
      currency=excluded.currency,
      import_only=excluded.import_only,
      notes=excluded.notes,
      raw_json=excluded.raw_json,
      last_sync_at=excluded.last_sync_at,
      updated_at=excluded.updated_at`).run({
    id: account.id,
    provider: account.provider || 'manual',
    connectionId: account.connectionId || null,
    name: account.name,
    officialName: account.officialName || null,
    institution: account.institution || null,
    mask: account.mask || null,
    kind: account.kind || 'other',
    subtype: account.subtype || null,
    balance: Number(account.balance || 0),
    availableBalance: account.availableBalance == null ? null : Number(account.availableBalance),
    currency: account.currency || 'USD',
    importOnly: account.importOnly ? 1 : 0,
    notes: account.notes || null,
    rawJson: stringify(account.raw),
    lastSyncAt: account.lastSyncAt || null,
    createdAt: account.createdAt || now,
    updatedAt: now,
  })
}

export function upsertTransaction(snapshot, tx) {
  const con = db()
  const now = nowIso()
  const normalized = {
    ...tx,
    amount: Number(tx.amount || 0),
    category: tx.category || 'Uncategorized',
    reviewed: Boolean(tx.reviewed),
  }
  const ruleCategory = categoryFromRules(normalized)
  con.prepare(`INSERT INTO transactions
    (id, source, provider, account_id, date, merchant, description, amount, currency, category,
     pending, reviewed, raw_json, created_at, updated_at)
    VALUES (@id, @source, @provider, @accountId, @date, @merchant, @description, @amount, @currency, @category,
     @pending, @reviewed, @rawJson, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source,
      provider=excluded.provider,
      account_id=excluded.account_id,
      date=excluded.date,
      merchant=excluded.merchant,
      description=excluded.description,
      amount=excluded.amount,
      currency=excluded.currency,
      category=excluded.category,
      pending=excluded.pending,
      reviewed=excluded.reviewed,
      raw_json=excluded.raw_json,
      updated_at=excluded.updated_at`).run({
    id: normalized.id,
    source: normalized.source || 'manual',
    provider: normalized.provider || 'manual',
    accountId: normalized.accountId || null,
    date: normalized.date || null,
    merchant: normalized.merchant || null,
    description: normalized.description || null,
    amount: normalized.amount,
    currency: normalized.currency || 'USD',
    category: ruleCategory || normalized.category,
    pending: normalized.pending ? 1 : 0,
    reviewed: normalized.reviewed ? 1 : 0,
    rawJson: stringify(normalized.raw),
    createdAt: normalized.createdAt || now,
    updatedAt: now,
  })
}

export function removeTransaction(snapshot, id) {
  db().prepare('DELETE FROM transactions WHERE id = ?').run(id)
}

export function addSyncEvent(event) {
  const con = db()
  con.prepare(`INSERT OR REPLACE INTO sync_events (id, provider, kind, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(
    event.id,
    event.provider || 'local',
    event.kind || 'event',
    stringify(event.payload || event.body || event.results || event),
    event.createdAt || nowIso(),
  )
}

export function listTransactions(limit = 100) {
  return db()
    .prepare('SELECT * FROM transactions ORDER BY date DESC, created_at DESC LIMIT ?')
    .all(Math.min(Number(limit || 100), 5000))
    .map(transactionFromRow)
}

export function listDocuments() {
  return db().prepare("SELECT * FROM documents ORDER BY COALESCE(due_date, '9999-99-99'), title").all().map(documentFromRow)
}

export function listTaxTasks() {
  return db().prepare("SELECT * FROM tax_tasks ORDER BY COALESCE(due_date, '9999-99-99'), priority DESC").all().map(taxTaskFromRow)
}

// Category for movements between the user's OWN accounts (e.g. credit-card
// autopay from checking, brokerage contributions). Both legs stay in the ledger
// so per-account balances reconcile, but a transfer is neither income nor
// spending, so cashflow/summary/category-spend/subscription aggregations must
// skip it or every internal transfer inflates income AND spending by the same
// amount each month.
const TRANSFER_CATEGORY = 'Transfer'

export function listCashflow() {
  const txs = listTransactions(5000)
  const byMonth = new Map()
  for (const tx of txs) {
    if (tx.category === TRANSFER_CATEGORY) continue
    const month = monthText(tx.date)
    const bucket = byMonth.get(month) || { month, income: 0, spending: 0, net: 0, count: 0 }
    if (tx.amount < 0) bucket.income += Math.abs(tx.amount)
    else bucket.spending += tx.amount
    bucket.net = bucket.income - bucket.spending
    bucket.count += 1
    byMonth.set(month, bucket)
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 18)
}

export function captureSnapshot(source = 'system') {
  const con = db()
  const snapshot = readDb()
  const balances = balanceSummaryFromSnapshot(snapshot)
  const date = todayText()
  const now = nowIso()
  const id = `snapshot_${date}`
  con.prepare(`INSERT INTO snapshots
    (id, date, net_worth, assets, debt, cash, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      net_worth=excluded.net_worth,
      assets=excluded.assets,
      debt=excluded.debt,
      cash=excluded.cash,
      source=excluded.source,
      updated_at=excluded.updated_at`).run(
    id,
    date,
    balances.netWorth,
    balances.assets,
    balances.debt,
    balances.cash,
    source,
    now,
    now,
  )
  return con.prepare('SELECT * FROM snapshots WHERE date = ?').get(date)
}

export function listHistory(range = '1Y') {
  const con = db()
  const rows = con.prepare('SELECT * FROM snapshots ORDER BY date ASC').all().map(snapshotFromRow)
  const latest = rows.at(-1)?.date || todayText()
  const days = { '1M': 35, '3M': 100, '1Y': 370, ALL: 10000 }[String(range || '1Y').toUpperCase()] || 370
  const cutoff = new Date(`${latest}T00:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - days)
  const snapshots = rows.filter((row) => new Date(`${row.date}T00:00:00Z`) >= cutoff)
  return {
    range: String(range || '1Y').toUpperCase(),
    snapshots,
    cashflow: listCashflow().slice().reverse(),
    categories: categorySpendForMonth(latestTransactionMonth()),
  }
}

export function categorySpendForMonth(month = latestTransactionMonth()) {
  return db()
    .prepare(`SELECT COALESCE(category, 'Uncategorized') AS category, SUM(amount) AS total, COUNT(*) AS count
      FROM transactions
      WHERE amount > 0 AND substr(date, 1, 7) = ? AND COALESCE(category, '') != ?
      GROUP BY COALESCE(category, 'Uncategorized')
      ORDER BY total DESC`)
    .all(month, TRANSFER_CATEGORY)
    .map((row) => ({
      category: row.category,
      total: Number(row.total || 0),
      count: Number(row.count || 0),
    }))
}

export function listBudgets() {
  const con = db()
  const currentMonth = latestTransactionMonth()
  const previousMonth = addMonths(currentMonth, -1)
  return con.prepare('SELECT * FROM budgets ORDER BY category').all().map((row) => {
    const budget = budgetFromRow(row)
    const current = con.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM transactions WHERE amount > 0 AND substr(date, 1, 7) = ? AND category = ?`).get(currentMonth, budget.category)
    const previous = con.prepare(`SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions WHERE amount > 0 AND substr(date, 1, 7) = ? AND category = ?`).get(previousMonth, budget.category)
    const merchants = con.prepare(`SELECT COALESCE(merchant, description, 'Unknown') AS merchant, SUM(amount) AS total, COUNT(*) AS count
      FROM transactions
      WHERE amount > 0 AND substr(date, 1, 7) = ? AND category = ?
      GROUP BY COALESCE(merchant, description, 'Unknown')
      ORDER BY total DESC LIMIT 4`).all(currentMonth, budget.category)
    const spent = Number(current.total || 0)
    // A monthly_limit <= 0 means "no cap": it must never read as over-budget.
    // remaining=null (unlimited, not negative) and percent=0 keep the display honest.
    const hasCap = budget.monthlyLimit > 0
    return {
      ...budget,
      month: currentMonth,
      spent,
      transactionCount: Number(current.count || 0),
      remaining: hasCap ? budget.monthlyLimit - spent : null,
      percent: hasCap ? Math.min(999, Math.round((spent / budget.monthlyLimit) * 100)) : 0,
      deltaFromPrevious: Number(previous.total || 0) - spent,
      topMerchants: merchants.map((merchant) => ({
        merchant: merchant.merchant,
        total: Number(merchant.total || 0),
        count: Number(merchant.count || 0),
      })),
    }
  })
}

export function createBudget(body = {}) {
  const con = db()
  const now = nowIso()
  const category = String(body.category || '').trim()
  if (!category) {
    const err = new Error('category is required')
    err.status = 400
    throw err
  }
  const budget = {
    id: body.id || `budget_${crypto.randomUUID()}`,
    category,
    monthlyLimit: Number(body.monthlyLimit ?? body.monthly_limit ?? 0),
    color: body.color || '#3ddc97',
    notes: body.notes || null,
  }
  con.prepare(`INSERT INTO budgets (id, category, monthly_limit, color, notes, created_at, updated_at)
    VALUES (@id, @category, @monthlyLimit, @color, @notes, @createdAt, @updatedAt)
    ON CONFLICT(category) DO UPDATE SET
      monthly_limit=excluded.monthly_limit,
      color=excluded.color,
      notes=excluded.notes,
      updated_at=excluded.updated_at`).run({
    ...budget,
    createdAt: now,
    updatedAt: now,
  })
  return listBudgets().find((item) => item.category === category)
}

export function updateBudget(id, body = {}) {
  const con = db()
  const existing = con.prepare('SELECT * FROM budgets WHERE id = ?').get(id)
  if (!existing) {
    const err = new Error('budget not found')
    err.status = 404
    throw err
  }
  const next = {
    category: String(body.category || existing.category).trim(),
    monthlyLimit: Number(body.monthlyLimit ?? body.monthly_limit ?? existing.monthly_limit),
    color: body.color || existing.color,
    notes: body.notes ?? existing.notes,
    updatedAt: nowIso(),
    id,
  }
  con.prepare(`UPDATE budgets SET category = @category, monthly_limit = @monthlyLimit, color = @color,
    notes = @notes, updated_at = @updatedAt WHERE id = @id`).run(next)
  return listBudgets().find((item) => item.id === id)
}

export function deleteBudget(id) {
  const result = db().prepare('DELETE FROM budgets WHERE id = ?').run(id)
  return { deleted: result.changes }
}

export function listRules() {
  return db().prepare('SELECT * FROM rules ORDER BY enabled DESC, updated_at DESC').all().map(ruleFromRow)
}

export function createRule(body = {}) {
  const con = db()
  const now = nowIso()
  const pattern = String(body.pattern || '').trim().toLowerCase()
  const category = String(body.category || '').trim()
  if (!pattern || !category) {
    const err = new Error('pattern and category are required')
    err.status = 400
    throw err
  }
  const rule = {
    id: body.id || `rule_${crypto.randomUUID()}`,
    pattern,
    category,
    target: body.target || 'merchant_description',
    enabled: body.enabled === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
  }
  con.prepare(`INSERT INTO rules (id, pattern, category, target, enabled, created_at, updated_at)
    VALUES (@id, @pattern, @category, @target, @enabled, @createdAt, @updatedAt)
    ON CONFLICT(pattern) DO UPDATE SET category=excluded.category, target=excluded.target,
      enabled=excluded.enabled, updated_at=excluded.updated_at`).run(rule)
  // On conflict the surviving row keeps its ORIGINAL id, so look up by pattern
  // (the dedup key) rather than by rule.id, which would be absent after an update.
  return listRules().find((item) => item.pattern === pattern)
}

export function deleteRule(id) {
  const result = db().prepare('DELETE FROM rules WHERE id = ?').run(id)
  if (!result.changes) {
    const err = new Error('rule not found')
    err.status = 404
    throw err
  }
  return { deleted: true }
}

export function setRuleEnabled(id, enabled) {
  const result = db().prepare('UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, nowIso(), id)
  if (!result.changes) {
    const err = new Error('rule not found')
    err.status = 404
    throw err
  }
  return listRules().find((item) => item.id === id)
}

export function runRules({ includeReviewed = false } = {}) {
  const con = db()
  const txs = con.prepare('SELECT * FROM transactions ORDER BY date DESC').all().map(transactionFromRow)
  let updated = 0
  for (const tx of txs) {
    if (tx.reviewed && !includeReviewed) continue
    const category = categoryFromRules({ ...tx, reviewed: includeReviewed ? false : tx.reviewed })
    if (category && category !== tx.category) {
      con.prepare('UPDATE transactions SET category = ?, updated_at = ? WHERE id = ?').run(category, nowIso(), tx.id)
      updated += 1
    }
  }
  return { updated, rules: listRules().filter((rule) => rule.enabled).length }
}

export function updateTransactionCategory(id, body = {}) {
  const con = db()
  const tx = con.prepare('SELECT * FROM transactions WHERE id = ?').get(id)
  if (!tx) {
    const err = new Error('transaction not found')
    err.status = 404
    throw err
  }
  const category = String(body.category || '').trim()
  if (!category) {
    const err = new Error('category is required')
    err.status = 400
    throw err
  }
  con.prepare('UPDATE transactions SET category = ?, reviewed = 1, updated_at = ? WHERE id = ?').run(category, nowIso(), id)
  let rule = null
  if (body.always) {
    const pattern = String(body.pattern || tx.merchant || tx.description || '').trim().toLowerCase()
    if (pattern) {
      rule = createRule({ pattern, category })
      runRules()
    }
  }
  return {
    transaction: transactionFromRow(con.prepare('SELECT * FROM transactions WHERE id = ?').get(id)),
    rule,
  }
}

export function listSubscriptions() {
  // A recurring internal transfer (e.g. a fixed monthly brokerage contribution)
  // is not a subscription; excluding TRANSFER_CATEGORY keeps it out of the list.
  const txs = listTransactions(5000).filter((tx) => tx.amount > 0 && tx.category !== TRANSFER_CATEGORY)
  const groups = new Map()
  for (const tx of txs) {
    const key = (tx.merchant || tx.description || 'Unknown').toLowerCase()
    const group = groups.get(key) || {
      merchant: tx.merchant || tx.description || 'Unknown',
      category: tx.category,
      amounts: [],
      dates: [],
      transactions: [],
    }
    group.amounts.push(tx.amount)
    group.dates.push(tx.date)
    group.transactions.push(tx)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => {
      const avg = group.amounts.reduce((sum, amount) => sum + amount, 0) / group.amounts.length
      const variance = group.amounts.reduce((sum, amount) => sum + Math.abs(amount - avg), 0) / group.amounts.length
      return {
        merchant: group.merchant,
        category: group.category,
        monthlyCost: Math.round(avg * 100) / 100,
        chargeCount: group.amounts.length,
        lastCharged: group.dates.filter(Boolean).sort().at(-1) || null,
        cadence: 'monthly',
        confidence: group.category === 'Subscriptions' ? 0.96 : variance < 4 && group.amounts.length >= 4 ? 0.74 : 0.42,
      }
    })
    .filter((item) => item.category === 'Subscriptions' || (item.chargeCount >= 4 && item.confidence >= 0.7))
    .sort((a, b) => b.monthlyCost - a.monthlyCost)
}

export function listCategories() {
  const fromTransactions = db()
    .prepare("SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL AND category != ''")
    .all()
    .map((row) => row.category)
  const fromBudgets = db().prepare('SELECT category FROM budgets').all().map((row) => row.category)
  return [...new Set([...DEFAULT_CATEGORIES, ...fromTransactions, ...fromBudgets])].sort()
}

export function transactionsCsv() {
  const rows = listTransactions(5000)
  const headers = ['date', 'merchant', 'description', 'category', 'provider', 'accountId', 'amount', 'currency', 'reviewed']
  const lines = [headers.join(',')]
  for (const tx of rows) {
    lines.push(headers.map((key) => csvEscape(tx[key])).join(','))
  }
  return `${lines.join('\n')}\n`
}

export function actionQueue() {
  const snapshot = readDb()
  const actions = []
  const today = new Date()
  const inDays = (dateText) => {
    if (!dateText) return 9999
    return Math.ceil((new Date(`${dateText}T00:00:00`) - today) / 86400000)
  }

  for (const account of snapshot.accounts) {
    const daysSinceSync = account.lastSyncAt
      ? Math.floor((today - new Date(account.lastSyncAt)) / 86400000)
      : account.provider === 'manual'
        ? null
        : 9999
    if (account.importOnly) {
      actions.push({
        id: `import_${account.id}`,
        type: 'import',
        priority: 'medium',
        title: `Refresh ${account.name}`,
        detail: 'This account updates from exports, not a live connection.',
        dueDate: null,
      })
    } else if (daysSinceSync != null && daysSinceSync > 2) {
      actions.push({
        id: `sync_${account.id}`,
        type: 'sync',
        priority: 'high',
        title: `Sync ${account.name}`,
        detail: 'Account data is stale or has not synced yet.',
        dueDate: null,
      })
    }
  }

  for (const budget of listBudgets()) {
    // Only capped budgets (monthlyLimit > 0) can be over budget; a no-cap budget
    // has remaining=null and must never spam the action queue.
    if (budget.monthlyLimit > 0 && budget.remaining < 0) {
      actions.push({
        id: `budget_${budget.id}`,
        type: 'budget',
        priority: 'high',
        title: `${budget.category} is over budget`,
        detail: `${budget.month} spending is ${Math.round(budget.percent)}% of plan.`,
        dueDate: null,
      })
    }
  }

  for (const doc of snapshot.documents) {
    const days = inDays(doc.dueDate)
    if (doc.status !== 'verified' && days <= 60) {
      actions.push({
        id: `doc_${doc.id}`,
        type: 'document',
        priority: days <= 14 ? 'high' : 'medium',
        title: doc.title,
        detail: `${doc.institution || 'Document'} is ${doc.status}.`,
        dueDate: doc.dueDate,
      })
    }
  }

  for (const task of snapshot.taxTasks) {
    if (task.status === 'done') continue
    actions.push({
      id: `tax_${task.id}`,
      type: 'tax',
      priority: task.priority,
      title: task.title,
      detail: task.notes || 'Tax task needs review.',
      dueDate: task.dueDate,
    })
  }

  return actions.sort((a, b) => {
    const rank = { high: 0, medium: 1, normal: 2, low: 3 }
    return (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || inDays(a.dueDate) - inDays(b.dueDate)
  })
}

export function summary(snapshot = readDb()) {
  const balances = balanceSummaryFromSnapshot(snapshot)
  const txs = snapshot.transactions
  const latestMonth = latestTransactionMonth()
  // Internal transfers are excluded from income/spending: both legs live in the
  // ledger for balance reconciliation but move no money in or out overall.
  const monthTxs = txs.filter((tx) => monthText(tx.date) === latestMonth && tx.category !== TRANSFER_CATEGORY)
  const spending30 = monthTxs.filter((tx) => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0)
  const income30 = monthTxs.filter((tx) => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0)
  const latestTxDate = txs.map((tx) => tx.date).filter(Boolean).sort().at(-1) || null
  const missingDocs = snapshot.documents.filter((d) => d.status !== 'verified').length
  const actions = actionQueue().length

  return {
    asOf: nowIso(),
    ...balances,
    cashRunwayMonths: spending30 > 0 ? Math.round((balances.cash / spending30) * 10) / 10 : null,
    income30,
    spending30,
    accounts: snapshot.accounts.length,
    transactions: snapshot.transactions.length,
    connections: snapshot.connections.length,
    missingDocs,
    actions,
    latestTransactionDate: latestTxDate,
    latestMonth,
  }
}
