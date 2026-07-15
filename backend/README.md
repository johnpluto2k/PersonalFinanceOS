# Personal Finance OS Backend

Local-first backend and served web app for connected financial accounts, transactions, Apple Card imports, and future document/tax workflows.

## Why this shape

- Do not collect raw bank passwords.
- Use an account-link provider for banks/cards/investments.
- Store only provider tokens, encrypted with `PFOS_MASTER_KEY`.
- Persist application data in local SQLite at `data/finance-os.sqlite`.
- Sync transactions incrementally with provider cursors.
- Treat Apple Card as an import lane first: Apple supports transaction export from Wallet/card.apple.com, but a normal web backend cannot simply log into Apple Wallet and stream every Apple Pay transaction.

## Run

```powershell
cd C:\ClaudeProjects\PersonalFinanceOS\backend
Copy-Item .env.example .env
npm.cmd run dev
```

No package install is needed for this first backend; it uses Node built-ins only, including Node's SQLite module.

Open the app at:

```text
http://127.0.0.1:8787/
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Server and storage health |
| `GET` | `/api/summary` | Net worth, assets, debt, transaction counts |
| `GET` | `/api/accounts` | Stored accounts |
| `GET` | `/api/accounts/:id/history?range=1M\|3M\|1Y\|All` | Per-account balance history as `{ accountId, range, kind, currency, snapshots: [{ date, balance }] }`, reconstructed backward from the current balance through the account's transactions (asset kinds move by `-amount`, credit/debt kinds by `+amount`; integer-cent math). Always includes a point for today equal to the current balance, so an account with no in-range transactions still charts a flat line. `404` unknown account, `400` unknown range |
| `GET` | `/api/connections` | Linked provider connections with sync status (`lastSyncedAt`, `lastError`) and health fields: `health` (`healthy`/`degraded`/`down`), `consecutiveFailures`, `lastErrorClass` |
| `DELETE` | `/api/connections/:id` | Unlink a connection and remove only its provider-linked accounts and transactions (manual + Apple import data untouched) |
| `GET` | `/api/transactions?limit=100` | Unified transaction ledger |
| `GET` | `/api/transactions.csv` | CSV export of the unified ledger |
| `PATCH` | `/api/transactions/:id` | Recategorize a transaction and optionally create an automation rule |
| `GET` | `/api/action-queue` | Highest-priority money/tax/sync actions |
| `GET` | `/api/cashflow` | Monthly income/spending summary |
| `GET` | `/api/history?range=1M` | Net-worth snapshots, cashflow bars, and category spend for charting |
| `GET` | `/api/budgets` | Monthly budgets with spend, delta, progress, and top merchants |
| `POST` | `/api/budgets` | Create or upsert a monthly category budget |
| `PATCH` | `/api/budgets/:id` | Update a budget |
| `DELETE` | `/api/budgets/:id` | Delete a budget |
| `GET` | `/api/rules` | Merchant/description categorization rules |
| `POST` | `/api/rules` | Create or upsert a categorization rule (deduped by pattern) |
| `PATCH` | `/api/rules/:id` | Enable or disable a rule |
| `DELETE` | `/api/rules/:id` | Delete a rule |
| `POST` | `/api/rules/run` | Apply enabled rules retroactively |
| `GET` | `/api/subscriptions` | Recurring transaction detection |
| `GET` | `/api/categories` | Known categories from defaults, budgets, and transactions |
| `GET` | `/api/documents` | Document checklist |
| `GET` | `/api/taxes` | Tax prep tasks |
| `POST` | `/api/manual/accounts` | Add a manual account |
| `POST` | `/api/import/apple-card` | Import Apple Card exported CSV text |
| `GET` | `/api/providers` | Registered providers with `{ id, label, configured, linkMode }`; `linkMode` is `sdk` (browser Plaid Link flow) or `direct` (plain link-token → exchange round-trip, e.g. `mock` "Demo Bank") |
| `POST` | `/api/providers/:provider/check` | Structured health check: `configured`/`ok`/error code; never throws. 404 for unknown provider |
| `POST` | `/api/providers/:provider/link-token` | Create a link token for any registered provider (`/api/providers/plaid/link-token` unchanged) |
| `POST` | `/api/providers/:provider/exchange-public-token` | Exchange a public token and store the encrypted access token (`/api/providers/plaid/exchange-public-token` unchanged) |
| `POST` | `/api/sync` | Sync linked provider accounts; optional JSON body `{ connectionId }` syncs just that connection, otherwise all active connections of every registered provider. Each connection syncs through the resilient sync engine: errors are classified (`config`/`auth`/`rate-limit`/`provider-down`/`unknown`), transient classes (`provider-down`, `rate-limit`) retry up to 3 attempts with exponential backoff + half jitter (~500ms base, 2s cap), permanent classes fail fast, and failures never abort other connections. Failed result entries carry `errorClass` and `attempts`; consecutive failures drive the connection `health` field |
| `POST` | `/api/webhooks/plaid` | Plaid webhook receiver stub |

## Apple Card import

Export transactions from Wallet or card.apple.com, then post the CSV text:

```powershell
$csv = Get-Content .\apple-card.csv -Raw
Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/import/apple-card `
  -ContentType 'application/json' `
  -Body (@{ csv = $csv } | ConvertTo-Json)
```

## Provider plan

Plaid is the first adapter because it covers broad US bank/card/investment data and has Link, Transactions Sync, Liabilities, and Investments APIs. The adapter boundary is intentionally thin so Teller, MX, Finicity, SimpleFIN, or a custom CSV importer can be added without rewriting the rest of the app.

Adapters live in `src/providers/` and register in `src/providers/index.mjs` with a uniform shape: `{ id, label, isConfigured(), createLinkToken(), exchangePublicToken(db, publicToken, metadata), syncConnection(db, connection), check() }`. The built-in `mock` adapter ("Demo Bank") needs no credentials: linking it seeds three accounts (Demo Checking, Demo Credit Card, Demo Brokerage) with ~12 months of deterministic transactions, its fake access token still flows through the real `cryptoVault` encryption path, and each subsequent `/api/sync` trickles 2-5 new transactions via a cursor exactly like Plaid's incremental sync.

## QA

Playwright smoke test and screenshots:

```powershell
cd C:\ClaudeProjects\PersonalFinanceOS
node qa-playwright.cjs
```

Screenshots are written to:

- `shots/desktop-*.png`
- `shots/mobile-*.png`

The Playwright runner screenshots every primary section at desktop and mobile widths, checks horizontal overflow, and exercises the core Apple CSV import -> transaction recategorization -> budget update flow.
