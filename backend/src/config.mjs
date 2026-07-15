import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()

export const config = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  dbPath: path.join(ROOT, 'data', 'finance-os.sqlite'),
  port: Number(process.env.PORT || 8787),
  masterKey: process.env.PFOS_MASTER_KEY || '',
  plaid: {
    env: process.env.PLAID_ENV || 'sandbox',
    // Optional API base override (testing/self-hosted proxies). Empty = use the
    // standard per-environment Plaid host; no behavior change when unset.
    // Trailing slashes are stripped so `${base}${path}` never double-slashes.
    baseUrl: (process.env.PLAID_BASE_URL || '').replace(/\/+$/, ''),
    clientId: process.env.PLAID_CLIENT_ID || '',
    secret: process.env.PLAID_SECRET || '',
    products: (process.env.PLAID_PRODUCTS || 'transactions,auth,liabilities,investments')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    countryCodes: (process.env.PLAID_COUNTRY_CODES || 'US')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
}

export function requireConfiguredMasterKey() {
  if (config.masterKey.length < 24) {
    const err = new Error('PFOS_MASTER_KEY is required before storing real provider tokens.')
    err.status = 400
    throw err
  }
}
