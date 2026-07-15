// Provider registry.
//
// Every account-link provider is exposed to the rest of the app through one
// uniform adapter shape:
//   { id, label, isConfigured(), createLinkToken(), exchangePublicToken(db,
//     publicToken, metadata), syncConnection(db, connection), check() }
// server.mjs routes and /api/sync dispatch purely on connection.provider via
// getProvider(); no provider-specific shapes leak past this module.
import { config } from '../config.mjs'
import {
  createLinkToken as plaidCreateLinkToken,
  exchangePublicToken as plaidExchangePublicToken,
  syncPlaidConnection,
} from './plaid.mjs'
import {
  check as mockCheck,
  createLinkToken as mockCreateLinkToken,
  exchangePublicToken as mockExchangePublicToken,
  syncConnection as mockSyncConnection,
} from './mock.mjs'

const plaidProvider = {
  id: 'plaid',
  label: 'Plaid',
  // 'sdk': linking requires the browser-side Plaid Link SDK flow.
  linkMode: 'sdk',
  isConfigured() {
    return Boolean(config.plaid.clientId && config.plaid.secret)
  },
  createLinkToken: plaidCreateLinkToken,
  exchangePublicToken: plaidExchangePublicToken,
  syncConnection: syncPlaidConnection,
  // Never throws: always returns a structured pass/fail result the UI can
  // render as "not configured" / "ready" / "error <code>".
  async check() {
    if (!this.isConfigured()) {
      return {
        provider: 'plaid',
        configured: false,
        ok: false,
        error: 'not configured',
        message: 'Set PLAID_CLIENT_ID and PLAID_SECRET in backend/.env.',
      }
    }
    try {
      // One cheap authenticated call proves the credentials work end to end.
      await plaidCreateLinkToken()
      return { provider: 'plaid', configured: true, ok: true, message: 'Plaid credentials are valid.' }
    } catch (err) {
      return {
        provider: 'plaid',
        configured: true,
        ok: false,
        error: err.details?.error_code || err.message || 'Plaid check failed',
        errorCode: err.details?.error_code || null,
        errorMessage: err.details?.error_message || err.message || null,
      }
    }
  },
}

const mockProvider = {
  id: 'mock',
  label: 'Demo Bank',
  // 'direct': plain link-token -> exchange-public-token round-trip, no SDK.
  linkMode: 'direct',
  isConfigured() {
    return true
  },
  createLinkToken: mockCreateLinkToken,
  exchangePublicToken: mockExchangePublicToken,
  syncConnection: mockSyncConnection,
  check: mockCheck,
}

const PROVIDERS = new Map([
  [plaidProvider.id, plaidProvider],
  [mockProvider.id, mockProvider],
])

export function getProvider(id) {
  return PROVIDERS.get(String(id || '')) || null
}

export function listProviders() {
  return [...PROVIDERS.values()].map((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: provider.isConfigured(),
    linkMode: provider.linkMode,
  }))
}
