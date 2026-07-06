# Prompt: Personal Finance OS — v2 (features + full UI overhaul)

Copy everything below into a new session with the `PersonalFinanceOS` folder connected.

---

You're working in my `PersonalFinanceOS` project. It's a local-first finance app: vanilla JS frontend (`index.html`, `app.js`, `styles.css`) served by a zero-dependency Node backend (`backend/src/server.mjs`, SQLite store in `backend/src/store.mjs`, Plaid adapter, Apple Card CSV import). Read the backend README first. Keep the constraints: Node built-ins only (no npm deps in backend), local SQLite, encrypted provider tokens, thin provider adapter boundary.

Do two things: overhaul the UI completely, and ship the feature set below. Work feature-by-feature, updating backend + frontend together, and run `node qa-playwright.cjs` for screenshots after major milestones so you can see and iterate on the design yourself.

## Part 1 — UI/UX overhaul (full redesign, not a touch-up)

Throw out the current look (sage/serif/paper theme). Rebuild as a **modern dark fintech dashboard** — think Linear / Copilot Money / Mercury-at-night:

- **Theme**: near-black background (#0A0A0B–#111214 range), elevated card surfaces with subtle 1px borders instead of drop shadows, one accent color (electric green or violet) used sparingly for primary actions and positive deltas. Semantic red/green for money in/out only.
- **Type**: Inter or Geist (system-ui fallback), tabular numerals for all money (`font-variant-numeric: tabular-nums`). Kill the serif display font. Tight type scale: 13px body, 12px labels, big numbers earn their size.
- **Layout**: keep the sidebar but make it compact (icons + labels, 220px), collapsible on mobile to a bottom tab bar. Dense but breathable grid — consistent 8px spacing system, no giant hero headline eating the top of the viewport. Net worth belongs in a stat row with sparkline, not a billboard.
- **Components**: rebuild cards, tables, badges, buttons as a small consistent system in `styles.css` with CSS variables. Transactions as a real table (sortable columns, hover rows, category chips with per-category colors, right-aligned amounts). Skeleton loading states instead of blank panels. Empty states with a clear CTA. Toast notifications for actions (import done, sync done, errors).
- **Micro-interactions**: 150ms transitions on hover/expand, animated number count-up on the summary stats, smooth section switching (no full repaint jank).
- **Accessibility**: visible focus rings, WCAG AA contrast on the dark palette, `prefers-reduced-motion` respected.
- **Verify visually**: after the redesign, take desktop + mobile screenshots, look at them, and fix what's ugly. Repeat until it looks like a product, not a prototype. I will judge it by the screenshots.

## Part 2 — New features (in priority order)

### 1. Charts & net worth history
- Add a `snapshots` table; record net worth/assets/debt daily (on server start + after every sync/import).
- `GET /api/history` endpoint. Overview: net worth line chart with 1M/3M/1Y/All ranges. Cashflow: monthly income-vs-spend bar chart. Spending: category donut for current month.
- No chart libraries — render with inline SVG (you're capable of clean SVG charts) or `<canvas>`. Tooltips on hover.

### 2. Budgets & spending insights
- `budgets` table (category, monthly limit). CRUD endpoints + a Budgets section in the UI.
- Per-category progress bars (spent vs. limit, colors shift as you approach the cap), month-over-month spend deltas, top merchants list.
- Feed "over budget in X" into the existing action queue.

### 3. Rules & automation
- `rules` table: match on merchant/description pattern → set category. `POST /api/rules`, applied on import/sync and retroactively via a "run rules" action.
- Recurring-transaction detection: flag transactions that recur at similar amounts/intervals → surface a **Subscriptions** panel (name, cadence, monthly cost, last charged) with estimated monthly subscription total.
- Inline recategorization in the transactions table (click category chip → dropdown → offer "always do this" to create a rule).

### 4. Tax & documents deepening
- Documents: statuses (needed / received / verified), per-document notes, year selector, progress meter ("6 of 9 docs in").
- Taxes: estimated-payment due dates surfaced in the action queue with countdown, simple deduction tracker (donations, education, interest paid) fed by tagged transactions.

### 5. Quality pass (do last)
- Search + filters on transactions (text, category, account, date range, amount).
- CSV export of the ledger (`GET /api/transactions.csv`).
- Keyboard shortcuts: `/` to focus search, `g` then section key to navigate.
- Extend `qa-playwright.cjs` to screenshot every section, desktop + mobile, and click through one core flow (import → categorize → budget updates).

## Ground rules
- Don't break existing endpoints or the Apple Card import path.
- Migrations: additive schema changes in `store.mjs`, safe on existing `finance-os.sqlite`.
- Seed enough demo data (6+ months of transactions across categories) that every chart, budget, and subscription panel looks real in screenshots.
- Update the backend README's API table for every new endpoint.
