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
| `POST` | `/api/rules` | Create a categorization rule |
| `POST` | `/api/rules/run` | Apply enabled rules retroactively |
| `GET` | `/api/subscriptions` | Recurring transaction detection |
| `GET` | `/api/categories` | Known categories from defaults, budgets, and transactions |
| `GET` | `/api/documents` | Document checklist |
| `GET` | `/api/taxes` | Tax prep tasks |
| `POST` | `/api/manual/accounts` | Add a manual account |
| `POST` | `/api/import/apple-card` | Import Apple Card exported CSV text |
| `POST` | `/api/providers/plaid/link-token` | Create a Plaid Link token |
| `POST` | `/api/providers/plaid/exchange-public-token` | Store encrypted Plaid access token |
| `POST` | `/api/sync` | Sync linked provider accounts |
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
