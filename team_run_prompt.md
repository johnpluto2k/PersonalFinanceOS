You're the conductor for the PersonalFinanceOS build team. The mission is to
execute `NEXT-PROMPT.md` (the v2 UI overhaul + feature set) — **one feature at a
time**, each fully verified before the next begins. Read `NEXT-PROMPT.md` and
`backend/README.md` first so the constraints are fresh.

Delegation is one level deep: you call subagents; subagents never call subagents.
Every delegated step returns evidence (a sample API response, a screenshot
filename, a reconciliation figure, a diff summary) — "done" without evidence gets
re-run.

## The per-feature loop

For the next unstarted feature in `NEXT-PROMPT.md` (Part 2 order: Charts & net
worth history → Budgets & spending insights → Rules & automation → Tax & documents
→ Quality pass), plus the Part 1 UI overhaul woven through:

1. **Plan (Gate 1).** Delegate to `planner` to shape the feature into a concrete,
   phased plan with file paths and a testing strategy. **Present the plan to me and
   get approval before any implementation.** Do not skip to coding.

2. **Implement the halves.** Delegate the backend half to `pfos-backend-dev`
   (endpoints, additive SQLite schema, provider adapter, seed data — under the hard
   constraints: Node built-ins only, encrypted tokens, adapter boundary) and the UI
   half to `pfos-ui-dev` (the dark fintech design system, vanilla JS, hand-rolled
   SVG/canvas charts). They stay in their lanes — ui-dev never edits backend, and
   backend-dev never edits `index.html`/`app.js`/`styles.css`.

3. **Screenshot-verify.** Delegate to `pfos-qa`: start the backend if needed, run
   `node qa-playwright.cjs`, read the real screenshots in `shots/`, and report
   concrete defects by filename. **pfos-ui-dev's work is not finished until pfos-qa
   passes it.** Loop implement → QA until the screenshots look like a product.

4. **Audit the numbers.** If the feature touched transactions/imports/sync/budgets,
   delegate to `pfos-data-auditor` (read-only) to reconcile balances vs transaction
   sums, category totals, import dedup, and cursor integrity — with exact figures.

5. **Review.** Delegate to the shared `code-reviewer`, **plus `security-reviewer`
   for anything touching Plaid, tokens, or imports** (and `database-reviewer` if the
   SQLite schema changed, `a11y-architect` for substantial UI). Resolve findings.

6. **Commit (Gate 2).** Summarize the diff, the QA screenshots, and the audit
   result, and **get my confirmation before committing.** Never commit `.env`,
   tokens, or `data/*.sqlite`. Update the backend README's API table for every new
   endpoint as part of the change.

Then — and only then — start the next feature. Do not begin feature N+1 until
feature N has passed QA, the audit, review, and the Gate 2 commit.

## Hard safety lines (never cross)

- **Node built-ins only** in the backend — no npm dependencies.
- **Never initiate transfers or payments.**
- **Never commit `.env`, provider tokens, or `data/*.sqlite`.**
- **Never weaken the token-encryption path** (`cryptoVault.mjs`).
- **Additive, safe migrations only** on the existing `finance-os.sqlite`.
- Don't break existing endpoints or the Apple Card import path.

## Headless note

This file is designed to be pasted into a session opened in `PersonalFinanceOS`,
or run with `claude -p "$(Get-Content team_run_prompt.md -Raw)"`. Gate 1 and Gate 2
require my input — when running headless, stop and surface the plan / the pre-commit
summary rather than proceeding through a gate on your own.
