# PersonalFinanceOS

**A local-first personal finance application** — connecting your banks and cards, tracking net worth, automating categorization, and surfacing your money in a modern dark fintech dashboard. All financial data stays on your machine: encrypted tokens, local SQLite, no cloud dependency.

## Features

| Feature | Status | UI/UX | Details |
| --- | --- | --- | --- |
| **Charts & Net Worth History** | ✅ | Modern | 1M/3M/1Y/All range, cashflow monthly bars, category donuts, account balance history |
| **Budgets & Spending Insights** | ✅ | Polish | Category limits, animated progress bars, color-coded status, MoM deltas, top merchants |
| **Rules & Automation** | ✅ | Polish | Merchant patterns → auto-categorize, recurring detection, subscription panel, inline rule creation |
| **Bank Connect (Plaid)** | ✅ | Modern | Streamlined QR link flow, cursor-based sync, multi-account, connection management |
| **Apple Card Import** | ✅ | Polish | CSV export from Wallet, instant import, toast confirmation, transaction categorization |
| **Manual Accounts** | ✅ | Modern | Add/edit offline accounts (savings, loans, investments), balance tracking |
| **Transaction Management** | ✅ | Modern | Unified ledger, sortable table, category chips, inline recategorize, heatmap, CSV export |
| **Dark Fintech Dashboard** | ✅ | Premium | Electric green accents, near-black backgrounds, 8px grid, tabular numerals, smooth transitions |
| **Mobile-First Responsive** | ✅ | Premium | Bottom tab bar, responsive charts, 44px+ touch targets, bottom-sheet modals, no horizontal scroll |
| **Keyboard Shortcuts** | ✅ | Power | `/` search, `g+section` nav, `?` help, `Esc` close, organized help modal |
| **Loading & Empty States** | ✅ | Polish | Skeleton loaders, friendly empty states with CTAs, smooth animations |
| **Toast Notifications** | ✅ | Polish | Import/rule/budget feedback, slide-in animations, auto-dismiss |

## Quick Start

### Prerequisites
- **Node.js** 18+ (ships with native SQLite)
- **Plaid account** (optional, for bank linking) — get free test credentials at [dashboard.plaid.com](https://dashboard.plaid.com)
- **Git**

### Installation & Run

```bash
# Clone or navigate to the project
cd C:\ClaudeProjects\PersonalFinanceOS

# Start the backend (serves frontend + API)
node backend/src/server.mjs

# Open in your browser
# http://127.0.0.1:8787
```

The backend runs on port `8787` by default. Override with:
```bash
PORT=3000 node backend/src/server.mjs
```

### First Steps in the App

1. **Add a manual account** — click "Add Account", enter a name and starting balance
2. **Import transactions** — go to "Import" and paste an Apple Card CSV export
3. **Create a budget** — go to "Budgets", set a monthly limit for a category (e.g., Dining Out $500)
4. **Link a bank** (optional) — click "Connect Bank", scan the Plaid Link QR code or enter credentials
5. **Watch the dashboard** — net worth chart, spending breakdown, action alerts

## Architecture

### Technology Stack

| Layer | Tech | Constraints |
| --- | --- | --- |
| **Frontend** | Vanilla HTML/CSS/JS | No build step, no npm deps |
| **Backend** | Node.js (built-ins only) | SQLite, no npm deps, port via `PORT` env var |
| **Database** | SQLite (local file) | One-file storage at `backend/data/finance-os.sqlite` |
| **Auth** | None (local-first) | Designed for single-user, local machine |
| **Providers** | Plaid adapter (thin) | Easy to swap/extend (Teller, MX, SimpleFIN) |

### Project Structure

```
PersonalFinanceOS/
├── index.html              # Frontend (dark fintech dashboard)
├── app.js                  # Frontend logic (state, events, DOM)
├── styles.css              # Design system (CSS variables, components)
├── backend/
│   ├── src/
│   │   ├── server.mjs      # HTTP server + API endpoints
│   │   ├── store.mjs       # SQLite persistence layer
│   │   ├── cryptoVault.mjs # Token encryption/decryption
│   │   ├── providers/
│   │   │   └── plaid.mjs   # Plaid Link + Transactions API
│   │   ├── appleCardImport.mjs  # CSV parser
│   │   └── config.mjs      # Environment + defaults
│   ├── data/
│   │   └── finance-os.sqlite  # Data file (created on first run)
│   └── README.md           # Backend technical docs
├── qa-playwright.cjs       # Visual QA + smoke tests
├── vault_summary.mjs       # Obsidian vault reporter (monthly notes)
├── NEXT-PROMPT.md          # Roadmap + future features
└── README.md               # This file
```

### Database Schema (Key Tables)

- **accounts** — linked banks, manual entries, Apple Card
- **transactions** — unified ledger (Plaid, Apple, manual)
- **connections** — provider link state (last sync, cursor, errors)
- **rules** — merchant patterns → category automation
- **budgets** — monthly category limits
- **snapshots** — daily net worth for charting
- **documents** — tax doc checklist (name, status, notes)

## API Reference

### Core Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Server + storage health check |
| `GET` | `/api/summary` | Net worth, assets, liabilities, tx counts |
| `GET` | `/api/accounts` | All accounts (Plaid-linked, manual, Apple) |
| `GET` | `/api/connections` | Link state per provider (last sync, errors) |
| `GET` | `/api/transactions?limit=100` | Unified transaction ledger, paginated |
| `GET` | `/api/transactions.csv` | CSV export (for Excel, Sheets, etc.) |
| `PATCH` | `/api/transactions/:id` | Recategorize + optionally create rule |
| `GET` | `/api/history?range=1M` | Net worth + cashflow snapshots for charts |
| `GET` | `/api/budgets` | All budgets with spend, delta, progress |
| `POST` | `/api/budgets` | Create/upsert budget |
| `GET` | `/api/rules` | Categorization rules (merchant patterns) |
| `POST` | `/api/rules` | Create/upsert rule |
| `POST` | `/api/rules/run` | Apply rules retroactively to all txs |
| `GET` | `/api/subscriptions` | Recurring transactions (monthly estimates) |
| `GET` | `/api/cashflow` | Monthly income vs. spend summary |
| `GET` | `/api/action-queue` | Alerts: overages, sync errors, tax deadlines |
| `POST` | `/api/import/apple-card` | Import CSV text from Apple Wallet export |
| `POST` | `/api/manual/accounts` | Add a manual account |
| `POST` | `/api/providers/plaid/link-token` | Get Plaid Link token (for QR flow) |
| `POST` | `/api/providers/plaid/exchange-public-token` | Store encrypted access token after link |
| `POST` | `/api/sync` | Sync all connections or one specific `connectionId` |

### Example Requests

**Add a manual account:**
```bash
curl -X POST http://127.0.0.1:8787/api/manual/accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "My Savings",
    "type": "savings",
    "balanceAmount": 5000,
    "balanceCurrency": "USD"
  }'
```

**Import Apple Card CSV:**
```bash
# Export from Wallet/card.apple.com, then:
$csv = Get-Content ./apple-card.csv -Raw
Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/import/apple-card `
  -ContentType 'application/json' `
  -Body (@{ csv = $csv } | ConvertTo-Json)
```

**Recategorize a transaction:**
```bash
curl -X PATCH http://127.0.0.1:8787/api/transactions/tx-id-123 \
  -H 'Content-Type: application/json' \
  -d '{
    "category": "Dining Out",
    "createRule": true  # optional: auto-categorize similar merchants in future
  }'
```

## Environment Setup

### `.env` Configuration

Create a `.env` file in `backend/` with:

```bash
# Plaid (optional, for bank linking)
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret
PLAID_ENV=sandbox  # or production

# Encryption key for provider tokens (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
PFOS_MASTER_KEY=your-64-character-hex-string

# Server
PORT=8787
LOG_LEVEL=info
```

**Plaid Setup:**
1. Sign up free at [dashboard.plaid.com](https://dashboard.plaid.com)
2. Go to **Team settings** → **API keys**
3. Copy `Client ID` and `Secret` for your environment (sandbox for testing)
4. Add to `.env`

**Master Key (encryption):**
Generate a secure random key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Running Tests & QA

### Visual Testing (Screenshots)

The project includes a Playwright-based QA suite that screenshots the app at desktop and mobile widths:

```bash
cd C:\ClaudeProjects\PersonalFinanceOS
node qa-playwright.cjs
```

Screenshots are saved to:
- `shots/desktop-*.png` — 1440×900 desktop layout
- `shots/mobile-*.png` — 375×667 mobile layout

The suite also exercises the core flow: import Apple CSV → recategorize → update budget.

### Manual Testing

1. **Transactions**: Add an account, import CSV, verify parsing and categorization
2. **Rules**: Create a rule, import txs, verify auto-categorization works
3. **Budgets**: Set a $100/month budget, spend > $100, verify overage alert in action queue
4. **Charts**: Check 1M/3M/1Y/All range toggles, net worth line, cashflow bars
5. **Plaid** (if configured): Link a test account, verify sync, check tx import

## Security & Privacy

### Data Storage
- **All financial data lives locally** — SQLite file at `backend/data/finance-os.sqlite`
- **No cloud sync by default** — optional: see `vault_summary.mjs` for Obsidian vault export
- **No raw bank credentials** — only encrypted Plaid access tokens (using `PFOS_MASTER_KEY`)

### Secrets Management
- Plaid tokens are encrypted before storage (`cryptoVault.mjs`)
- Master key is environment-only, never committed to git
- `.env` is in `.gitignore`

### Recommended Practices
1. **Backup** — periodically copy `backend/data/finance-os.sqlite` to external storage
2. **Master Key** — keep `PFOS_MASTER_KEY` secret; rotate annually or after suspected compromise
3. **Local Network** — only expose on trusted networks; no port forwarding to the internet

## Troubleshooting

### "Port 8787 already in use"
```bash
# Use a different port
PORT=3000 node backend/src/server.mjs
```

### "Cannot find module 'better-sqlite3'" or similar
This backend uses **Node built-ins only**, no npm install needed. If you see this:
- Delete `node_modules/` if it exists
- Verify you're running Node 18+: `node --version`
- Ensure you're in the repo root, not `backend/`

### "Plaid link fails" or "Exchange token error"
- Verify `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` in `.env`
- Check Plaid dashboard for errors: [dashboard.plaid.com](https://dashboard.plaid.com)
- Ensure `PLAID_ENV=sandbox` for test credentials

### "Transactions not imported"
- Check `/health` endpoint — if SQLite is down, sync will fail
- Verify Apple Card CSV format (use official export from Wallet/card.apple.com)
- Check `GET /api/action-queue` for import error details

### "Budget won't update" or "Overage alert missing"
- Verify transactions are categorized correctly (click to recategorize if needed)
- Check budget exists: `GET /api/budgets`
- Confirm today is not month-end (snapshots/alerts run daily at server start)

## Development & Contributing

### Running with Agent Team

A multi-agent build system is included for developing new features:

```bash
# Windows
run-finance-team.cmd

# Or directly
node team_run_prompt.md
```

This reads `NEXT-PROMPT.md` and works through features in sequence, pausing at two gates:
1. **Gate 1 (Plan)** — AI architect proposes implementation strategy
2. **Gate 2 (Pre-commit)** — QA verifies feature, then commits if approved

### Code Style

- **Frontend**: Vanilla JS, no frameworks; keep `app.js` under 1500 LOC
- **Backend**: Node built-ins only; no npm deps; lean on SQLite for state
- **CSS**: Design tokens via CSS variables; dark theme optimized

### Adding a New Provider

The `backend/src/providers/` directory has a thin adapter interface:

```js
// Example: backend/src/providers/teller.mjs
export async function linkToken(config) {
  // Return a link token or URL
}

export async function sync(accessToken, lastCursor) {
  // Return { transactions: [...], nextCursor }
}
```

Add your adapter, update `server.mjs` to wire it, and extend the UI connection flow.

## v2.0.0 Release Status

**✅ SHIPPED** (2026-07-09)

### What's New in v2

**Phase 1 — Design System** (Commit a51cae6)
- CSS tokens: colors, spacing, typography, transitions
- Mobile bottom tab bar (desktop sidebar retained)
- Card refinement: 1px borders, hover effects, consistent spacing
- Typography: system stack, tabular numerals on all currency

**Phase 2 — Charts & Data** (Commit 8cee70e)
- Chart.js integration (6 views: net worth line, budget bars, cashflow stacked, transactions heatmap, accounts multi-line, subscriptions recurring)
- Account balance history endpoint (`GET /api/accounts/:id/history?range=1M|3M|1Y|All`)
- Interactive tooltips, range selectors, smooth animations
- Budget delta sign bug fixed

**Phase 3 — UX Polish** (Commit 46db87e)
- Loading skeletons (shimmer animations on all charts/cards)
- Empty states (friendly CTAs for all 10 views)
- Transaction table enhancements (category chips, inline recategorize, sortable, heatmap strip)
- Toast notifications (import/rule/budget feedback)
- Keyboard shortcuts (navigation chords, search, help modal)
- Micro-interactions (number animations, section fades, button ripples)
- Mobile optimizations (responsive, 44px targets, bottom sheets, internal table scrolling)
- Accessibility (WCAG AA contrast, focus rings, prefers-reduced-motion support)

### Design System Reference

**Colors** (CSS variables in `styles.css`):
- `--bg-primary`: #0A0A0B (near-black)
- `--bg-elevated`: #1A1A1E (card background)
- `--accent`: #3DCF8E (electric green, primary actions)
- `--semantic-positive`: #3DCF8E (income, ok budgets)
- `--semantic-negative`: #FF4545 (expenses, over budgets)
- `--text-primary`: #FFFFFF (main text)
- `--text-secondary`: #A0A0A0 (muted text)

**Spacing** (8px grid):
- `--space-xs`: 4px
- `--space-sm`: 8px
- `--space-md`: 16px
- `--space-lg`: 24px
- `--space-xl`: 32px

**Typography**:
- `--font-body`: Inter, -apple-system, system-ui, sans-serif
- `--font-size-sm`: 12px (labels)
- `--font-size-base`: 13px (body)
- `--font-size-lg`: 16px (subheadings)
- `--font-size-xl`: 20px (headings)
- `--font-size-2xl`: 28px (hero numbers)
- Tabular numerals on all `.amount`, `.price`, `.balance`, `.money` classes

**Transitions**:
- `--transition-fast`: 150ms ease (hover, focus)
- `--transition-normal`: 200ms ease (section switches, modals)

## Roadmap (v3+)

See `NEXT-PROMPT.md` for full vision:
- Tax prep deepening (estimated payments, deduction tracker)
- Documents management (checklist, years, verification)
- Search & filters (transactions, date ranges, amount bounds)
- CSV export (downloadable ledger)
- Quality pass (accessibility, performance, edge cases)

## License

Private project. For questions, reach out to the maintainer.

---

**Last updated 2026-07-09.**
