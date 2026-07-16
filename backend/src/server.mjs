import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { parseAppleCardCsv } from './appleCardImport.mjs'
import { getProvider, listProviders } from './providers/index.mjs'
import { clearSyncFailures, syncWithRetry } from './syncEngine.mjs'
import {
  accountHistory,
  actionQueue,
  addSyncEvent,
  captureSnapshot,
  createBudget,
  createRule,
  deleteBudget,
  deleteConnection,
  deleteRule,
  deriveHealth,
  insightsReport,
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
  ['/charts.js', 'charts.js'],
])

// This server also serves its own frontend, so real requests are same-origin and
// carry no Origin header — those need no ACAO at all. We only emit ACAO for a
// cross-origin XHR whose Origin is a local loopback on THIS server's port; any
// other site (which could otherwise read bank data or trigger DELETE/sync against
// 127.0.0.1) is refused a permissive header. A wildcard '*' is never sent.
function allowedOrigin(origin) {
  if (!origin) return null
  const allow = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`])
  return allow.has(origin) ? origin : null
}

function corsHeaders(res) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
  if (res.__acao) {
    headers['Access-Control-Allow-Origin'] = res.__acao
    headers.Vary = 'Origin'
  }
  return headers
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(res),
  })
  res.end(JSON.stringify(body, null, 2))
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    ...corsHeaders(res),
  })
  res.end(body)
}

// Upper bound on request bodies. The largest legitimate payload is a full-year
// Apple Card CSV wrapped in JSON (well under 1 MB); 15 MB leaves generous head-
// room while making an unbounded-buffer memory exhaustion impossible.
const MAX_JSON_BODY_BYTES = 15 * 1024 * 1024

async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_JSON_BODY_BYTES) {
      const err = new Error('request body too large')
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    // A malformed body is the caller's error, not a 500 server fault.
    const err = new Error('request body is not valid JSON')
    err.status = 400
    throw err
  }
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
    lastSyncedAt: connection.lastSyncAt || null,
    lastError: connection.lastError || null,
    lastErrorClass: connection.lastErrorClass || null,
    consecutiveFailures: Number(connection.consecutiveFailures || 0),
    health: deriveHealth(connection),
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
  res.__acao = allowedOrigin(req.headers.origin)
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true })
  // CSRF guard for state-changing methods. Browsers attach an Origin header to
  // cross-site POSTs even when the response is unreadable (mode:'no-cors' with a
  // text/plain body needs no preflight), so a malicious page could otherwise
  // blindly trigger sync/import/delete against 127.0.0.1. Same-origin requests
  // carry this server's own origin (allowed) and curl/PowerShell send no Origin
  // header at all (allowed), so legitimate flows are unaffected.
  if (req.method !== 'GET' && req.headers.origin && !res.__acao) {
    return send(res, 403, { error: 'cross-origin write refused' })
  }
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

    // Per-account balance history for the Accounts chart. accountHistory throws
    // 404 (unknown account) / 400 (unknown range), surfaced via the catch below.
    const accountHistoryMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/history$/)
    if (accountHistoryMatch && req.method === 'GET') {
      return send(res, 200, accountHistory(
        decodeURIComponent(accountHistoryMatch[1]),
        url.searchParams.get('range') || '1Y',
      ))
    }

    if (req.method === 'GET' && url.pathname === '/api/connections') {
      const db = readDb()
      return send(res, 200, db.connections.map(publicConnection))
    }

    const connectionMatch = url.pathname.match(/^\/api\/connections\/([^/]+)$/)
    if (connectionMatch && req.method === 'DELETE') {
      const result = deleteConnection(decodeURIComponent(connectionMatch[1]))
      captureSnapshot('connection_unlink')
      return send(res, 200, result)
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

    // Feature 3: savings rates, EOM cash forecast, spending anomalies, and
    // subscription price increases — all computed on read in store/insights.
    if (req.method === 'GET' && url.pathname === '/api/insights') {
      return send(res, 200, insightsReport())
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

    if (req.method === 'GET' && url.pathname === '/api/providers') {
      return send(res, 200, listProviders())
    }

    // Generalized provider routes. /api/providers/plaid/* keeps its exact
    // historical behavior — plaid is just one registry entry now.
    const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/(link-token|exchange-public-token|check)$/)
    if (providerMatch && req.method === 'POST') {
      const providerId = decodeURIComponent(providerMatch[1])
      const action = providerMatch[2]
      const provider = getProvider(providerId)
      if (!provider) return send(res, 404, { error: `unknown provider: ${providerId}` })

      if (action === 'check') {
        return send(res, 200, await provider.check())
      }

      if (action === 'link-token') {
        const token = await provider.createLinkToken()
        return send(res, 200, token)
      }

      const body = await readJson(req)
      if (!body.public_token) return send(res, 400, { error: 'public_token is required' })
      const db = readDb()
      const connection = await provider.exchangePublicToken(db, body.public_token, body.metadata || {})
      // A successful (re-)link is a fresh start for resilience bookkeeping —
      // without this reset a 'down' connection would stay 'down' until the
      // next good sync. Done here so every provider gets it.
      const linked = db.connections.find((c) => c.id === connection.id)
      if (linked) clearSyncFailures(linked)
      writeDb(db)
      captureSnapshot(`${provider.id}_link`)
      return send(res, 201, connection)
    }

    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await readJson(req)
      const targetId = body.connectionId ? String(body.connectionId) : null
      const db = readDb()
      // A caller-supplied connectionId must resolve to a real, syncable connection.
      // Silently returning {results:[]} would mask a bad id or a disabled connection.
      let targetConn = null
      if (targetId) {
        targetConn = db.connections.find((c) => c.id === targetId)
        if (!targetConn) {
          const err = new Error('connection not found')
          err.status = 404
          throw err
        }
        if (!getProvider(targetConn.provider) || targetConn.status !== 'active') {
          const err = new Error('connection is not an active syncable connection')
          err.status = 400
          throw err
        }
      }
      // Any registered provider's active connections sync; each connection is
      // dispatched to its own adapter's syncConnection via the registry.
      const targets = db.connections.filter(
        (c) => getProvider(c.provider) && c.status === 'active' && (!targetId || c.id === targetId),
      )
      const results = []
      // One failing connection must not abort the whole loop: syncWithRetry never
      // throws — it classifies the error, retries only transient classes with
      // bounded backoff, records lastError/lastErrorClass/consecutiveFailures on
      // the connection (persisted via writeDb -> upsertConnection), and returns a
      // structured {ok:false, errorClass, attempts} result. Success resets the
      // failure bookkeeping.
      for (const connection of targets) {
        results.push(await syncWithRetry(db, connection))
      }
      db.syncEvents.push({
        id: `sync_${crypto.randomUUID()}`,
        provider: targetConn ? targetConn.provider : 'all',
        connectionId: targetId,
        kind: 'manual_sync',
        payload: { connectionId: targetId, results },
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
