import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { parseAppleCardCsv } from './appleCardImport.mjs'
import { createLinkToken, exchangePublicToken, syncPlaidConnection } from './providers/plaid.mjs'
import {
  actionQueue,
  addSyncEvent,
  captureSnapshot,
  createBudget,
  createRule,
  deleteBudget,
  deleteRule,
  listCashflow,
  listBudgets,
  listCategories,
  listDocuments,
  listHistory,
  listRules,
  listSubscriptions,
  listTaxTasks,
  listTransactions,
  readDb,
  runRules,
  setRuleEnabled,
  summary,
  transactionsCsv,
  updateBudget,
  updateTransactionCategory,
  upsertAccount,
  upsertTransaction,
  writeDb,
} from './store.mjs'

const FRONTEND_ROOT = path.resolve(config.root, '..')
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
])

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(body, null, 2))
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

function sendStatic(res, fileName) {
  const fullPath = path.join(FRONTEND_ROOT, fileName)
  if (!fs.existsSync(fullPath)) return false
  const mime = fileName.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : fileName.endsWith('.js')
      ? 'application/javascript; charset=utf-8'
      : 'text/html; charset=utf-8'
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(fullPath).pipe(res)
  return true
}

function publicConnection(connection) {
  return {
    id: connection.id,
    provider: connection.provider,
    displayName: connection.displayName,
    status: connection.status,
    updatedAt: connection.updatedAt,
    hasCursor: Boolean(connection.cursor),
  }
}

function addManualAccount(body) {
  const now = new Date().toISOString()
  return {
    id: body.id || `manual_${crypto.randomUUID()}`,
    provider: 'manual',
    name: body.name,
    institution: body.institution || 'Manual',
    kind: body.kind || 'checking',
    subtype: body.subtype || null,
    balance: Number(body.balance || 0),
    currency: body.currency || 'USD',
    notes: body.notes || '',
    createdAt: now,
    updatedAt: now,
  }
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true })
  const url = new URL(req.url, `http://${req.headers.host}`)

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const db = readDb()
      return send(res, 200, {
        ok: true,
        storage: config.dbPath,
        plaidConfigured: Boolean(config.plaid.clientId && config.plaid.secret),
        masterKeyConfigured: config.masterKey.length >= 24,
        updatedAt: db.updatedAt,
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/summary') {
      return send(res, 200, summary())
    }

    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      const db = readDb()
      return send(res, 200, db.accounts)
    }

    if (req.method === 'GET' && url.pathname === '/api/connections') {
      const db = readDb()
      return send(res, 200, db.connections.map(publicConnection))
    }

    if (req.method === 'GET' && url.pathname === '/api/transactions') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 100), 1000)
      return send(res, 200, listTransactions(limit))
    }

    if (req.method === 'GET' && url.pathname === '/api/transactions.csv') {
      return sendText(res, 200, transactionsCsv(), 'text/csv; charset=utf-8')
    }

    const transactionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)$/)
    if (transactionMatch && req.method === 'PATCH') {
      const body = await readJson(req)
      const updated = updateTransactionCategory(decodeURIComponent(transactionMatch[1]), body)
      captureSnapshot('transaction_update')
      return send(res, 200, updated)
    }

    if (req.method === 'GET' && url.pathname === '/api/action-queue') {
      return send(res, 200, actionQueue())
    }

    if (req.method === 'GET' && url.pathname === '/api/cashflow') {
      return send(res, 200, listCashflow())
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      return send(res, 200, listHistory(url.searchParams.get('range') || '1Y'))
    }

    if (req.method === 'GET' && url.pathname === '/api/budgets') {
      return send(res, 200, listBudgets())
    }

    if (req.method === 'POST' && url.pathname === '/api/budgets') {
      const body = await readJson(req)
      const budget = createBudget(body)
      captureSnapshot('budget_create')
      return send(res, 201, budget)
    }

    const budgetMatch = url.pathname.match(/^\/api\/budgets\/([^/]+)$/)
    if (budgetMatch && req.method === 'PATCH') {
      const body = await readJson(req)
      const budget = updateBudget(decodeURIComponent(budgetMatch[1]), body)
      captureSnapshot('budget_update')
      return send(res, 200, budget)
    }

    if (budgetMatch && req.method === 'DELETE') {
      return send(res, 200, deleteBudget(decodeURIComponent(budgetMatch[1])))
    }

    if (req.method === 'GET' && url.pathname === '/api/rules') {
      return send(res, 200, listRules())
    }

    if (req.method === 'POST' && url.pathname === '/api/rules') {
      const body = await readJson(req)
      const rule = createRule(body)
      return send(res, 201, rule)
    }

    const ruleMatch = url.pathname.match(/^\/api\/rules\/([^/]+)$/)
    if (ruleMatch && url.pathname !== '/api/rules/run' && req.method === 'DELETE') {
      return send(res, 200, deleteRule(decodeURIComponent(ruleMatch[1])))
    }

    if (ruleMatch && url.pathname !== '/api/rules/run' && req.method === 'PATCH') {
      const body = await readJson(req)
      const rule = setRuleEnabled(decodeURIComponent(ruleMatch[1]), body.enabled)
      return send(res, 200, rule)
    }

    if (req.method === 'POST' && url.pathname === '/api/rules/run') {
      const body = await readJson(req)
      const result = runRules({ includeReviewed: Boolean(body.includeReviewed) })
      captureSnapshot('rules_run')
      return send(res, 200, result)
    }

    if (req.method === 'GET' && url.pathname === '/api/subscriptions') {
      return send(res, 200, listSubscriptions())
    }

    if (req.method === 'GET' && url.pathname === '/api/categories') {
      return send(res, 200, listCategories())
    }

    if (req.method === 'GET' && url.pathname === '/api/documents') {
      return send(res, 200, listDocuments())
    }

    if (req.method === 'GET' && url.pathname === '/api/taxes') {
      return send(res, 200, listTaxTasks())
    }

    if (req.method === 'POST' && url.pathname === '/api/manual/accounts') {
      const body = await readJson(req)
      if (!body.name) return send(res, 400, { error: 'name is required' })
      const db = readDb()
      const account = addManualAccount(body)
      upsertAccount(db, account)
      writeDb(db)
      captureSnapshot('manual_account')
      return send(res, 201, account)
    }

    if (req.method === 'POST' && url.pathname === '/api/import/apple-card') {
      const body = await readJson(req)
      const txs = parseAppleCardCsv(body.csv)
      const db = readDb()
      upsertAccount(db, {
        id: 'apple_card_manual',
        provider: 'apple',
        name: 'Apple Card',
        institution: 'Apple Card',
        kind: 'credit',
        balance: body.balance ? Number(body.balance) : 0,
        currency: 'USD',
        importOnly: true,
      })
      for (const tx of txs) upsertTransaction(db, tx)
      db.syncEvents.push({
        id: `sync_${crypto.randomUUID()}`,
        provider: 'apple',
        kind: 'csv_import',
        payload: { imported: txs.length },
        createdAt: new Date().toISOString(),
      })
      writeDb(db)
      captureSnapshot('apple_import')
      return send(res, 201, { imported: txs.length, accountId: 'apple_card_manual' })
    }

    if (req.method === 'POST' && url.pathname === '/api/providers/plaid/link-token') {
      const token = await createLinkToken()
      return send(res, 200, token)
    }

    if (req.method === 'POST' && url.pathname === '/api/providers/plaid/exchange-public-token') {
      const body = await readJson(req)
      if (!body.public_token) return send(res, 400, { error: 'public_token is required' })
      const db = readDb()
      const connection = await exchangePublicToken(db, body.public_token, body.metadata || {})
      writeDb(db)
      captureSnapshot('plaid_link')
      return send(res, 201, connection)
    }

    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const db = readDb()
      const results = []
      for (const connection of db.connections.filter((c) => c.provider === 'plaid' && c.status === 'active')) {
        results.push(await syncPlaidConnection(db, connection))
      }
      db.syncEvents.push({
        id: `sync_${crypto.randomUUID()}`,
        provider: 'all',
        kind: 'manual_sync',
        payload: { results },
        createdAt: new Date().toISOString(),
      })
      writeDb(db)
      captureSnapshot('sync')
      return send(res, 200, { results, summary: summary() })
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/plaid') {
      const body = await readJson(req)
      addSyncEvent({
        id: `sync_${crypto.randomUUID()}`,
        provider: 'plaid',
        kind: 'webhook',
        payload: body,
        createdAt: new Date().toISOString(),
      })
      return send(res, 200, { received: true })
    }

    if (req.method === 'GET' && STATIC_FILES.has(url.pathname)) {
      if (sendStatic(res, STATIC_FILES.get(url.pathname))) return
    }

    return send(res, 404, { error: 'Not found' })
  } catch (err) {
    return send(res, err.status || 500, {
      error: err.message || 'Internal server error',
      details: err.details,
    })
  }
}

try {
  captureSnapshot('server_start')
} catch (err) {
  console.warn(`Could not capture startup snapshot: ${err.message}`)
}

http.createServer(handle).listen(config.port, '127.0.0.1', () => {
  console.log(`Personal Finance OS backend listening on http://127.0.0.1:${config.port}`)
})
