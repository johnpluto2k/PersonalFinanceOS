// Resilient sync layer.
//
// Wraps every provider adapter's syncConnection() with error classification and
// bounded retry so one flaky provider can neither crash /api/sync nor hang it:
// only transient classes ('provider-down', 'rate-limit') are retried, with
// exponential backoff + half jitter, 3 attempts total, waits capped at ~2s
// (worst case ~3-4s per connection). Permanent classes ('config', 'auth',
// 'unknown') fail fast. syncWithRetry NEVER throws — it always returns a
// structured result and records failure bookkeeping on the connection object
// (persisted by the caller via writeDb -> upsertConnection).
import { getProvider } from './providers/index.mjs'

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 500
const BACKOFF_FACTOR = 2
const MAX_DELAY_MS = 2000
const RETRYABLE_CLASSES = new Set(['provider-down', 'rate-limit'])

// Plaid error codes that mean OUR app credentials are wrong — remediation is
// "fix backend/.env", not "re-link the item", so they classify as 'config'.
const CONFIG_ERROR_CODES = new Set([
  'INVALID_API_KEYS',
  'INVALID_CLIENT_ID',
])

// Plaid error codes that mean the stored item token is bad or the user must
// re-authenticate with their institution — remediation is "re-link".
const AUTH_ERROR_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'INVALID_ACCESS_TOKEN',
])

// Network-level failure codes surfaced by undici/fetch on err.cause.code.
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

// Classify an error thrown by an adapter into one of:
//   'config'        — the app itself is misconfigured (Plaid keys / master key
//                     missing). Retrying cannot help; the user must edit .env.
//   'auth'          — the provider rejected our credentials or the stored item
//                     token (401/403 or a known Plaid auth error_code).
//   'rate-limit'    — provider throttling (429 / RATE_LIMIT_EXCEEDED). Transient.
//   'provider-down' — network-level fetch failure or provider 5xx. Transient.
//   'unknown'       — anything else; fail fast so real bugs stay visible.
// plaid.mjs errors carry err.status (HTTP) and err.details (Plaid's JSON body
// with error_code / error_type / error_message); network failures from fetch
// are TypeError('fetch failed') with err.cause.code.
export function classifyError(err) {
  if (!err) return 'unknown'
  const message = String(err.message || '')
  const status = Number(err.status || 0)
  const errorCode = String(err.details?.error_code || '')
  const errorType = String(err.details?.error_type || '')

  if (/not configured|PFOS_MASTER_KEY/i.test(message)) return 'config'
  // App-credential codes outrank the generic auth checks: INVALID_API_KEYS /
  // INVALID_CLIENT_ID mean misconfig on our side, not a broken item link.
  if (CONFIG_ERROR_CODES.has(errorCode)) return 'config'
  if (status === 401 || status === 403) return 'auth'
  if (AUTH_ERROR_CODES.has(errorCode)) return 'auth'
  if (status === 429 || errorCode === 'RATE_LIMIT_EXCEEDED' || errorType === 'RATE_LIMIT_EXCEEDED') {
    return 'rate-limit'
  }
  if (err.cause?.code && NETWORK_ERROR_CODES.has(String(err.cause.code))) return 'provider-down'
  if (message === 'fetch failed') return 'provider-down'
  if (status >= 500) return 'provider-down'
  return 'unknown'
}

// Reset a connection's resilience bookkeeping after a successful sync or a
// fresh (re-)link. Callers persist the mutation.
export function clearSyncFailures(connection) {
  connection.lastError = null
  connection.lastErrorClass = null
  connection.consecutiveFailures = 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Exponential backoff with HALF jitter: wait is uniform in
// [ceiling/2, ceiling] with ceiling = min(cap, base * factor^(attempt-1)).
// Simultaneous failures still spread out, but the wait can never collapse to
// ~0ms — the provider always gets breathing room before a retry.
function backoffDelayMs(attempt) {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * BACKOFF_FACTOR ** (attempt - 1))
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
}

// Sync one connection through its registered adapter with bounded retry.
// Mutates the connection object's bookkeeping fields (lastError,
// lastErrorClass, consecutiveFailures, updatedAt); the caller persists them.
// Never throws.
export async function syncWithRetry(db, connection) {
  const provider = getProvider(connection.provider)
  let lastError = null
  let lastClass // always assigned on every failure path before use
  let attemptsMade = 0

  if (!provider) {
    lastError = new Error(`unknown provider: ${connection.provider}`)
    lastClass = 'config'
  } else {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      attemptsMade = attempt
      try {
        const result = await provider.syncConnection(db, connection)
        // Adapter already set lastSyncAt/lastError/updatedAt on success; clear
        // the resilience bookkeeping too.
        clearSyncFailures(connection)
        return { ...result, attempts: attempt }
      } catch (err) {
        lastError = err
        lastClass = classifyError(err)
        if (!RETRYABLE_CLASSES.has(lastClass) || attempt === MAX_ATTEMPTS) break
        const delay = backoffDelayMs(attempt)
        console.warn(
          `[syncEngine] connection=${connection.id} class=${lastClass} attempt=${attempt}/${MAX_ATTEMPTS} failed (${lastError.message}); retrying in ${delay}ms`,
        )
        await sleep(delay)
      }
    }
  }

  const message = lastError?.message || 'Sync failed'
  connection.lastError = message
  connection.lastErrorClass = lastClass
  connection.consecutiveFailures = Number(connection.consecutiveFailures || 0) + 1
  connection.updatedAt = new Date().toISOString()
  return {
    connectionId: connection.id,
    ok: false,
    error: message,
    errorClass: lastClass,
    attempts: attemptsMade,
  }
}
