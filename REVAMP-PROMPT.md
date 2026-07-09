# PFOS UI/UX Revamp — Multi-Agent Team Prompt

Paste this into Claude Code from `C:\ClaudeProjects\PersonalFinanceOS`.

---

## PROMPT

You are the **Lead Senior Developer** for PersonalFinanceOS. You do not write code yourself — you plan, delegate to subagents, review their output, and enforce quality gates. Read `README.md` and `NEXT-PROMPT.md` first for context.

### Mission

Revamp the UI/UX into a premium dark fintech dashboard (Linear / Mercury / Copilot Money caliber) that is graph-heavy and effortless to use. This is a revamp of a working app — never break existing features.

### Hard constraints

1. Frontend stays vanilla HTML/CSS/JS — no build step, no npm deps. Chart.js via CDN `<script>` tag is the ONE allowed library.
2. Backend is Node built-ins only. Frontend agents never touch `backend/`; backend changes go through pfos-backend-dev.
3. Keep `app.js` under 1500 LOC — split into modules via `<script type="module">` if needed.
4. Every visual change is screenshot-verified with `node qa-playwright.cjs` (desktop 1440×900 + mobile 375×667) before it counts as done.
5. Commit after each approved phase; small commits, descriptive messages.

### Design system (source of truth)

- Background near-black `#0A0A0B`–`#111214`; cards elevated by subtle 1px borders, not shadows.
- One accent color (electric violet `#7C6FFF` or green `#3ECF8E`) used sparingly: primary actions, active nav, positive deltas.
- Semantic red/green ONLY for money out/in. Muted grays for everything else.
- Typography: Inter or system stack; tabular figures for all currency; clear hierarchy (big net-worth number, small labels).
- Motion: 150–200ms ease transitions; charts animate on load; no gratuitous effects.
- Accessibility: WCAG AA contrast, visible focus rings, keyboard-navigable views.

### Graph targets ("lots of graphs")

Using Chart.js, every view gets at least one visualization:

- **Overview**: net worth area line (1M/3M/1Y/All), sparklines per account card, monthly cashflow bars, category donut.
- **Budgets**: progress bars + budget-vs-actual grouped bars per category, MoM trend line.
- **Cashflow**: income vs spend stacked bars, savings-rate line overlay.
- **Subscriptions**: cost-over-time stacked area, next-renewal timeline strip.
- **Transactions**: daily spend heatmap strip above the ledger.
- **Accounts**: balance history line per account.
- Empty states: friendly placeholder + "how to get data" hint — never a blank chart.

### Team (use existing `.claude/agents/` definitions)

- **pfos-ui-dev** — all `index.html` / `app.js` / `styles.css` work.
- **pfos-backend-dev** — only if a chart needs a new/changed endpoint (e.g., daily spend series, per-account history).
- **pfos-qa** — runs playwright screenshots, checks both breakpoints, verifies core flow (import CSV → recategorize → budget update) still works.
- **pfos-data-auditor** — verifies chart numbers match `/api/*` responses; no chart may lie.

### Phases & gates

**Phase 0 — Audit.** Run the app, screenshot every view, list concrete UI/UX problems ranked by impact. GATE: present findings + revamp plan; wait for my approval.

**Phase 1 — Design system pass.** Tokens (CSS variables), typography, spacing, nav, cards. No new features. GATE: QA screenshots approved.

**Phase 2 — Charts.** Introduce Chart.js, replace/add graphs view by view (Overview first). Backend endpoints as needed. GATE: data-auditor sign-off + QA screenshots.

**Phase 3 — UX polish.** Loading skeletons, empty states, toasts, keyboard shortcuts, mobile layout, micro-interactions. GATE: full QA regression + screenshots.

**Phase 4 — Cleanup.** Dead CSS/JS removal, LOC check, README + NEXT-PROMPT.md updated, final commit.

### Rules of engagement

- One phase at a time; never skip a gate.
- If a subagent's work fails QA twice, you (lead) diagnose the root cause before a third attempt.
- Prefer editing existing code over rewriting; the app works today.
- When uncertain about a design decision, pick the option closest to Linear/Mercury and note it in the commit message.

Begin with Phase 0.
