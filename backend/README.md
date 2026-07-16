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

Optional storage overrides for testing/scratch installs: `PFOS_DATA_DIR` moves the data directory, `PFOS_DB_PATH` pins the SQLite file itself (default `data/finance-os.sqlite`).

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
| `GET` | `/api/transactions?limit=100` | Unified transaction ledger. `limit` is clamped to `[1, 1000]` (non-numeric falls back to 100; a negative value would otherwise mean *unlimited* to SQLite) |
| `GET` | `/api/transactions.csv` | CSV export of the unified ledger |
| `PATCH` | `/api/transactions/:id` | Recategorize a transaction and optionally create an automation rule |
| `GET` | `/api/action-queue` | Highest-priority money/tax/sync actions. Includes insight items: `anomaly` (unusual charges within 30 days of the ledger's latest date, capped at 5, priority = severity), `subscription` (price increases, e.g. "Netflix went up $2.00"), and `forecast` (high-priority projected cash shortfall when `projectedEndOfMonthCash < 0`) |
| `GET` | `/api/insights` | Full insights payload: `{ asOf, month, inputTruncated, savings, forecast, anomalies, subscriptions }` — all computed on read from the ledger (no insight tables). `asOf` is the latest transaction date, not the wall clock. `inputTruncated` is `true` when the ledger holds more than the 5000 newest transactions the detectors read (see Insights algorithms) |
| `GET` | `/api/cashflow` | Monthly income/spending summary (includes pending rows; unchanged — insight forecast/savings use their own pending-excluded buckets, see Insights algorithms) |
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

### Request handling and hardening (v3 Feature 5)

- All JSON responses are served as `application/json; charset=utf-8`.
- Request bodies are capped at 15 MB (`413 request body too large`); a body that is not valid JSON returns `400`, not `500`.
- CSRF guard: any non-GET request carrying an `Origin` header that is not this server's own loopback origin is refused with `403 cross-origin write refused`. Browsers attach `Origin` to cross-site POSTs even in `no-cors` mode, so a malicious page can no longer blind-fire sync/import/delete against `127.0.0.1`. Same-origin app requests and header-less clients (curl, `Invoke-RestMethod`) are unaffected, and CORS reads were already refused via the strict per-origin ACAO policy.
- Provider tokens only ever exist encrypted (AES-256-GCM via `cryptoVault.mjs`): `/api/connections` serves a scrubbed public shape, no endpoint or log line carries a token, and the test suite asserts the raw SQLite/WAL bytes never contain a plaintext token.

## Insights algorithms

All detection lives in the pure module `src/insights.mjs` (no DB imports; unit-tested via `npm run test`). `store.mjs` assembles `GET /api/insights` from the ledger on read — there are no insight tables and no schema change. Money math runs in integer cents. This section is the auditor's contract: every threshold used, exactly.

**Input cap**: every detector reads at most the 5000 newest transactions (`listTransactions(5000)`, unchanged). On a bigger ledger the oldest history silently falls out of the detectors' view, so the payload carries the additive flag `inputTruncated: true` (`false` whenever the whole ledger fits). Existing fields are unchanged.

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

Spend txs are grouped by seriesKey; each group is date-sorted. The series' `merchant`, `category`, and the Subscriptions-category exception all key off the **newest** charge (v1 semantics: a merchant recategorized going forward is judged by its current category).

- **Cadence** from the median of consecutive day-gaps: weekly 6–8d (center 7), monthly 25–35d (center 30.44), annual 330–400d (center 365.25); anything else is non-recurring. Monthly/weekly require ≥ 3 charges; annual requires ≥ 2.
- **Interval regularity**: ≥ 70% of intervals within ±20% of the cadence center, else reject.
- **Price runs**: date-sorted charge amounts are compressed into runs of stable pricing — a new run starts when a charge differs from the *current run's median* by **at least** `tolerance = max($2.00, 5% × medianAmount)` (≥, in cents, so the canonical $2.00 bump against a $2.00 tolerance splits).
- **Amount conformity (per-run)**: `amountConformity` = share of charges living in runs of length ≥ 2; reject when < 70%. (The old whole-series-median rule rejected the exact price-increase series this feature targets: 6 × $9.99 + 4 × $12.99 scored 6⁄10 = 0.6 < 0.7. Per-run, that series is two stable runs covering 100% of charges; erratic per-charge drift still scores 0.) Exception carried from v1: `category = 'Subscriptions'` (on the newest charge) is always listed (cadence defaults to monthly when undetectable).
- **Price increase**: compare the last run against the nearest *preceding* run of length ≥ 2; the last run must itself have ≥ 2 charges. Both guards matter: a single charge at a new price is not yet confirmed, and a single discounted promo charge between stable runs must not fabricate an increase measured against the promo price. If the last run's median exceeds the comparison run's by ≥ `max($1.00, 2%)`, `priceIncrease = { previousAmount, newAmount, delta, percent, effectiveDate (first charge of the last run), confirmedCharges }`.
- **monthlyCost** (headline, current price): derived from the **last run's median** — a series that just went up reads at its new rate (Netflix shows $17.49, not the all-time median $15.49). Monthly → last-run median; annual → ÷ 12; weekly → × 52⁄12. `medianAmount` separately keeps the whole-series median.
- **confidence**: `0.5 + 0.2·(category = 'Subscriptions') + 0.15·(intervalConformity ≥ 0.85) + 0.15·(amountConformity ≥ 0.9)`, capped at 0.98.
- **nextExpectedDate**: lastCharged + 7/30/365 days by cadence.

### Forecast (`computeForecast`, catch-up-to-baseline)

Over monthly buckets computed from the ledger transactions via `monthlyCashflowFromTransactions` — **pending and Transfer rows excluded**, the same transaction set anomalies/subscriptions see. (This is intentionally *not* `/api/cashflow`'s series: that endpoint keeps pending rows and is unchanged.) Baseline = the 3 complete calendar months before the asOf month (`avgIncome`, `avgSpend`); MTD actuals = the asOf month's bucket. Then `projectedIncome = max(incomeMtd, avgIncome)`, `projectedSpending = max(spendMtd, avgSpend)`, and `projectedEndOfMonthCash = cashNow + (projectedIncome − incomeMtd) − (projectedSpending − spendMtd)`. When `projectedEndOfMonthCash < 0` the action queue adds a high-priority `forecast` item (months rendered as names, e.g. "July", not raw ISO).

### Savings rates (`computeSavingsRates`)

`rate_N = (Σincome − Σspend) / Σincome` over the N (3 and 6) complete calendar months strictly before the asOf month — the partial current month is excluded; `null` when Σincome = 0. Uses the same pending-excluded monthly buckets as the forecast. Surfaced as `savingsRate3m`/`savingsRate6m` on `/api/summary` and as `savings.threeMonth`/`savings.sixMonth` on `/api/insights`.

### Caching

`insightsReport()` (backing `/api/insights`, `/api/subscriptions`, the action-queue insight items, and `/api/summary`'s savings/forecast fields) is memoized on a ledger version key — `COUNT(*)` + `MAX(updated_at)` over `transactions`, plus `MAX(updated_at)` over `accounts` (the forecast's `cashNow` depends on balances). A page load that hits summary/actions/insights/subscriptions runs the detection pipeline once, not 3–4×; any write invalidates the memo on the next read.

### Demo data note

Fresh installs seed the demo Netflix series with the price bump already applied — 15.49 through 2026-05, 17.49 for 2026-06/2026-07 — and an Apple Card balance carrying the matching +$4.00, then set the `demo_insights_v3` meta flag. For DBs seeded before F3 (flat 15.49), `migrate()` performs a one-time, meta-flag-gated reconcile that bumps `demo_2026-06_netflix`/`demo_2026-07_netflix` from 15.49 → 17.49 and adds $2.00 per bumped row to the Apple Card balance (credit card: more spend = more owed). It is guarded by exact id **and** exact current amount, so user-edited data is never touched; the flag is only set when rows were actually bumped or the data is already post-bump — never against an empty (not-yet-seeded) transactions table, since `migrate()` runs before the seed.

## Apple Card import

Export transactions from Wallet or card.apple.com, then post the CSV text:

```powershell
$csv = Get-Content .\apple-card.csv -Raw
Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/import/apple-card `
  -ContentType 'application/json' `
  -Body (@{ csv = $csv } | ConvertTo-Json)
```

Parsing notes (v3 Feature 5 fixes):

- The real export column `Amount (USD)` is recognized (previously only a bare `Amount` header was, so genuine Wallet exports imported with amount 0). Accounting-style `(45.00)` negatives parse as `-45.00` (previously they became 0).
- Rows with neither a valid date nor a non-zero amount (summary/total lines, blank separators, truncated rows) are skipped without aborting the rest of the import.
- Row identity is `sha1(date + merchant + amount + daily cash)`, so re-importing the same CSV upserts onto the same ids — zero new rows — while two same-day/same-amount charges at *different* merchants stay distinct. Note: because amount participates in identity, rows previously imported with a zero amount by the two bugs above will import once more under their corrected ids.
- Formula-injection characters (`=`, `+`, `@`, ...) in CSV fields are stored as inert data; CSV content never reaches a response header or file path.

## Provider plan

Plaid is the first adapter because it covers broad US bank/card/investment data and has Link, Transactions Sync, Liabilities, and Investments APIs. The adapter boundary is intentionally thin so Teller, MX, Finicity, SimpleFIN, or a custom CSV importer can be added without rewriting the rest of the app.

Adapters live in `src/providers/` and register in `src/providers/index.mjs` with a uniform shape: `{ id, label, isConfigured(), createLinkToken(), exchangePublicToken(db, publicToken, metadata), syncConnection(db, connection), check() }`. The built-in `mock` adapter ("Demo Bank") needs no credentials: linking it seeds three accounts (Demo Checking, Demo Credit Card, Demo Brokerage) with ~12 months of deterministic transactions, its fake access token still flows through the real `cryptoVault` encryption path, and each subsequent `/api/sync` trickles 2-5 new transactions via a cursor exactly like Plaid's incremental sync.

## Tests

Node's built-in runner only — no test dependencies. From the repo root:

```powershell
node --test "backend/test/*.test.mjs"
```

or from `backend/`:

```powershell
npm.cmd run test        # node --test "test/**/*.test.mjs"
```

> Note: the bare directory form `node --test backend/test/` does **not** discover these files on this setup — use the quoted glob (or explicit file paths).

Suites (75 tests):

| File | Covers |
| --- | --- |
| `test/insights.test.mjs` | Pure detector/forecast/savings algorithms (the Insights algorithms contract above) |
| `test/providers.test.mjs` | Provider registry: lookup, unknown-provider handling, `registerProvider` validation/duplicate refusal, Plaid readiness check's not-configured path, `listProviders` public shape |
| `test/mockSync.test.mjs` | Demo Bank cursor sync on a scratch DB: deterministic backlog, cursor advance, incremental-only deliveries, idempotent re-sync/re-link (zero duplicates), to-the-cent balance reconciliation, encrypted-at-rest token (raw file bytes scanned for plaintext), tampered-token 401 |
| `test/syncEngine.test.mjs` | Error classification table; retry/backoff via injected fake providers (transient retries up to 3 attempts, permanent classes fail fast, unknown provider → `config`, one failing connection never aborts another) |
| `test/appleImport.test.mjs` | CSV parser (real `Amount (USD)` headers, quoting, paren negatives, BOM, malformed-row skipping, formula chars kept as data) plus import dedup through the store (same CSV twice → zero new rows; near-duplicates preserved) |
| `test/storeHardening.test.mjs` | `listTransactions` limit clamp and the insights `inputTruncated` signal on a >5000-row ledger |

Every suite pins `PFOS_DB_PATH`/`PFOS_DATA_DIR` to a scratch directory before importing any source module, so tests can never touch `data/finance-os.sqlite`, and presets empty `PLAID_*` variables so a developer's `.env` cannot leak into the not-configured assertions.

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
