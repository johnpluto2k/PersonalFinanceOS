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
| `GET` | `/api/summary` | Net worth, assets, debt, transaction counts, plus insight fields `savingsRate3m`, `savingsRate6m` (complete-month savings rates, `null` when window income is 0) and `forecastEndOfMonthCash` (see Insights algorithms) |
| `GET` | `/api/accounts` | Stored accounts |
| `GET` | `/api/accounts/:id/history?range=1M\|3M\|1Y\|All` | Per-account balance history as `{ accountId, range, kind, currency, snapshots: [{ date, balance }] }`, reconstructed backward from the current balance through the account's transactions (asset kinds move by `-amount`, credit/debt kinds by `+amount`; integer-cent math). Always includes a point for today equal to the current balance, so an account with no in-range transactions still charts a flat line. `404` unknown account, `400` unknown range |
| `GET` | `/api/connections` | Linked provider connections with sync status (`lastSyncedAt`, `lastError`) and health fields: `health` (`healthy`/`degraded`/`down`), `consecutiveFailures`, `lastErrorClass` |
| `DELETE` | `/api/connections/:id` | Unlink a connection and remove only its provider-linked accounts and transactions (manual + Apple import data untouched) |
| `GET` | `/api/transactions?limit=100` | Unified transaction ledger |
| `GET` | `/api/transactions.csv` | CSV export of the unified ledger |
| `PATCH` | `/api/transactions/:id` | Recategorize a transaction and optionally create an automation rule |
| `GET` | `/api/action-queue` | Highest-priority money/tax/sync actions. Includes insight items: `anomaly` (unusual charges within 30 days of the ledger's latest date, capped at 5, priority = severity), `subscription` (price increases, e.g. "Netflix went up $2.00"), and `forecast` (high-priority projected cash shortfall when `projectedEndOfMonthCash < 0`) |
| `GET` | `/api/insights` | Full insights payload: `{ asOf, month, savings, forecast, anomalies, subscriptions }` — all computed on read from the ledger (no insight tables). `asOf` is the latest transaction date, not the wall clock |
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
| `GET` | `/api/subscriptions` | Recurring charge detection v2, grouped per `(merchant, account)` — the same service on two cards yields two rows. Keeps every v1 field (`merchant`, `category`, `monthlyCost`, `chargeCount`, `lastCharged`, `cadence`, `confidence`) and adds `seriesKey`, `accountId`, `medianAmount`, `amountTolerance`, `intervalConformity`, `amountConformity`, `nextExpectedDate`, `priceIncrease` |
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

## Insights algorithms

All detection lives in the pure module `src/insights.mjs` (no DB imports; unit-tested via `npm run test`). `store.mjs` assembles `GET /api/insights` from the ledger on read — there are no insight tables and no schema change. Money math runs in integer cents. This section is the auditor's contract: every threshold used, exactly.

Shared definitions:

- **Spend tx**: `amount > 0 AND category != 'Transfer' AND pending = 0`
- **Income tx**: `amount < 0 AND category != 'Transfer' AND pending = 0`
- **merchantKey**: `lower(trim(coalesce(merchant, description, 'Unknown')))`
- **seriesKey** (subscriptions): `merchantKey || '|' || coalesce(account_id, '')`
- **asOf**: `MAX(date)` in the ledger — not the wall clock — so figures are stable between syncs
- **cashNow**: sum of balances over `checking`/`savings`/`cash` accounts (same definition as `/api/summary`'s `cash`)

### Anomalies (`detectAnomalies`, window = 60 days before asOf)

For each candidate spend tx `T` dated within the window:

1. Peer set = all *other* spend txs with the same merchantKey dated within 365 days up to and including `T.date` (same-day peers count). If < 5 merchant peers, fall back to same-category peers; if < 12 category peers, skip `T`.
2. `median` = median of peer amounts; `mad` = median of `|amount − median|`; `sigma = max(1.4826 × mad, 0.15 × median, $1.00)` — the floor protects zero-variance series (Rent $980 × 12 has MAD = 0).
3. Flag only when **all three** hold: `robustZ = (T.amount − median) / sigma ≥ 3.5`; `T.amount ≥ 2 × median`; `T.amount − median ≥ $25`.
4. `severity = 'high'` when `T.amount ≥ 3 × median`, else `'medium'`.

Action queue surfaces anomalies dated within 30 days of asOf, capped at 5 (most recent first); items are not dismissible in v3.

### Subscriptions v2 (`detectSubscriptionsV2`)

Spend txs are grouped by seriesKey; each group is date-sorted.

- **Cadence** from the median of consecutive day-gaps: weekly 6–8d (center 7), monthly 25–35d (center 30.44), annual 330–400d (center 365.25); anything else is non-recurring. Monthly/weekly require ≥ 3 charges; annual requires ≥ 2.
- **Interval regularity**: ≥ 70% of intervals within ±20% of the cadence center, else reject.
- **Amount drift**: `tolerance = max($2.00, 5% × medianAmount)`; ≥ 70% of charges within tolerance of the series median, else reject. Exception carried from v1: `category = 'Subscriptions'` is always listed (cadence defaults to monthly when undetectable).
- **Price increase**: date-sorted charges are compressed into runs — a new run starts when a charge differs from the *current run's median* by **at least** the tolerance (≥, in cents, so the canonical $2.00 bump against a $2.00 tolerance splits). If the last run's median exceeds the previous run's by ≥ `max($1.00, 2%)`, `priceIncrease = { previousAmount, newAmount, delta, percent, effectiveDate (first charge of the last run), confirmedCharges }`.
- **monthlyCost**: monthly → medianAmount; annual → ÷ 12; weekly → × 52⁄12.
- **confidence**: `0.5 + 0.2·(category = 'Subscriptions') + 0.15·(intervalConformity ≥ 0.85) + 0.15·(amountConformity ≥ 0.9)`, capped at 0.98.
- **nextExpectedDate**: lastCharged + 7/30/365 days by cadence.

### Forecast (`computeForecast`, catch-up-to-baseline)

Over `/api/cashflow` monthly buckets (Transfer excluded): baseline = the 3 complete calendar months before the asOf month (`avgIncome`, `avgSpend`); MTD actuals = the asOf month's bucket. Then `projectedIncome = max(incomeMtd, avgIncome)`, `projectedSpending = max(spendMtd, avgSpend)`, and `projectedEndOfMonthCash = cashNow + (projectedIncome − incomeMtd) − (projectedSpending − spendMtd)`. When `projectedEndOfMonthCash < 0` the action queue adds a high-priority `forecast` item.

### Savings rates (`computeSavingsRates`)

`rate_N = (Σincome − Σspend) / Σincome` over the N (3 and 6) complete calendar months strictly before the asOf month — the partial current month is excluded; `null` when Σincome = 0. Surfaced as `savingsRate3m`/`savingsRate6m` on `/api/summary` and as `savings.threeMonth`/`savings.sixMonth` on `/api/insights`.

### Demo data note

`migrate()` performs a one-time, meta-flag-gated (`demo_insights_v3`) reconcile that bumps the two most recent demo Netflix rows (`demo_2026-06_netflix`, `demo_2026-07_netflix`) from 15.49 → 17.49 so the price-increase detector has a real confirmed case. It is guarded by exact id **and** exact current amount, so user-edited data is never touched, and it never runs twice.

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
