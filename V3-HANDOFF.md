# v3 orchestration handoff — state as of 2026-07-15

Working tree: `C:\Users\yohan\orca\workspaces\PersonalFinanceOS\orca-orchestration-run`
(branch `johnpluto2k/orca-orchestration-run`). Spec: `C:/ClaudeProjects/PersonalFinanceOS/V3-ORCA-SPEC.md`.
Gate culture per `team_run_prompt.md`: Gate 1 (plan) and Gate 2 (pre-commit evidence) go to John; workers are the
`.claude/agents` lanes (pfos-backend-dev, pfos-ui-dev, pfos-qa, pfos-data-auditor + code review).

## Shipped (committed)

| Commit | Feature | Evidence |
| --- | --- | --- |
| `d5d6c63` | **F1** Provider registry + mock Demo Bank (Plaid-ready) | mock link→sync→ledger; readiness check returns clean "not configured" |
| `7679b94` | **F2** Resilient sync layer | forced-failure test (Plaid at unreachable host → `provider-down`, 3 attempts, ~1.5s) while Demo Bank synced in the same call; health chips + queue item QA'd; audit reconciled to the cent, zero dupes across retried syncs |
| `d21e66b` | **Fix** missing `GET /api/accounts/:id/history` (pre-existing Phase 2 gap; was 8 console 404s per Accounts load) | QA exit 0; every range's last point = live balance |
| (this commit) | **F3** Smarter insights — anomalies, subscription v2 + price increases, forecast, savings rate | QA exit 0 (injected $180 Chipotle flags at z=55.4, queue item present); full audit PASS (every figure reconciled, both-directions anomaly scan, all 11 subscription rows field-for-field); Gate 1 decisions: gated Netflix seed bump YES, per-(merchant,account) rows, shortfall queue item YES, dashed chart bar NO |

Tag `checkpoint-pre-feature3` = `d21e66b`.

## F3 pending backend review fixes (FIRST TASK NEXT SESSION — before Feature 4)

Code review verified these against the committed F3 code; the frontend fix package already landed
(savings-tile fallback, caption NaN fix, fmtRate consolidation, `.conn-error` ellipsis). The backend package
was interrupted by a session limit and is NOT applied. Dispatch to pfos-backend-dev
(backend/src/*, backend/test/*, backend/README.md only; Node built-ins only; update unit tests + README
"Insights algorithms" contract for every amendment; then re-run pfos-qa + pfos-data-auditor; Gate 2 before commit):

1. **Fresh-DB bug (worst)**: `demo_insights_v3` Netflix reconcile runs in `migrate()`, which executes BEFORE
   `seedIfEmpty()`/`ensureDemoDepth()` in `db()` (store.mjs ~112–114). Fresh DB ⇒ UPDATE matches 0 rows, flag set
   permanently, seed inserts Netflix at 15.49 ⇒ demo price-increase case dead on fresh installs. Fix: seed the last
   two months' Netflix at 17.49 directly in the seed path; keep the migrate() reconcile only for already-seeded DBs;
   set the flag only when rows actually updated or already post-bump — never on an empty transactions table.
   Test with a genuinely fresh scratch DB.
2. **Balance consistency**: the reconcile added $4.00 spend to `apple_card_manual` without adjusting its balance;
   bump balance +2.00/updated row (credit: more spend = more owed); make the fresh-seed apple-card balance
   consistent with seeded 17.49 rows.
3. **Category from newest charge**: `detectSubscriptionsV2` reads category/`isSubscriptionCategory` from
   `charges[0]` (oldest); v1 semantics keyed off newest. Use `charges.at(-1)`.
4. **Per-run amount conformity (algorithm amendment)**: whole-series-median conformity rejects the exact
   price-increase series the feature targets (6×$9.99 + 4×$12.99 ⇒ 0.6 < 0.7 ⇒ dropped). Compute price runs first
   (tolerance unchanged), accept when ≥70% of charges live in runs of length ≥2. Verify: Amazon/Costco/Safeway stay
   rejected; City Utilities (4+3) & Whole Foods (4+3) stay accepted; internet-bill case becomes accepted with
   increase detected.
5. **Promo guard**: price increase compares last run vs immediately previous run — a single $5.99 promo charge
   between $10.99 runs fabricates "went up $5.00". Require last run AND comparison run length ≥2 (comparison run =
   nearest preceding run with length ≥2). Netflix 5→2, City 4→3, Whole Foods 4→3 all still detect.
6. **Current-price headline**: `monthlyCost` (and annual/weekly derivation) from the LAST run's median so the
   Netflix card reads $17.49, not the all-time median 15.49 (QA-flagged display mismatch). Keep whole-series
   `medianAmount` as a field.
7. **Pending consistency**: forecast/savings consume `listCashflow()` buckets which INCLUDE pending; anomalies/
   subscriptions exclude pending. Compute monthly buckets inside insights.mjs from the transactions array (pending +
   Transfer excluded). `/api/cashflow` endpoint behavior must not change.
8. **Memoize `insightsReport()`** on a ledger version (`SELECT COUNT(*), MAX(updated_at) FROM transactions`);
   one page load currently runs the full pipeline 3–4× via summary()→actionQueue()→insightsReport +
   /api/actions + /api/insights + /api/subscriptions. summary() should reuse the memoized report instead of
   recomputing savings/forecast (store.mjs ~1591–1606).
9. Cleanups: dead `asOf` param in detectSubscriptionsV2 + both callers' O(n log n) max-date sorts (O(n) reduce);
   store.mjs↔insights.mjs duplicate helpers (`addMonthsText`/`monthOf`/`TRANSFER_CATEGORY` — import from insights);
   hoist MONTHLY_CADENCE; lazy `byCategory` build in detectAnomalies; humanize the shortfall action's raw ISO months;
   test fixture `monthlySeries` hardcodes year 2026 and yields invalid dates for non-default `startMonth`.

## Deferred / known issues (Feature 5 hardening candidates)

- **Snapshot-writeback race**: `/api/sync` writes back its whole `readDb()` snapshot after up to ~4s of retries;
  a re-link completing mid-sync gets clobbered (stale token restored). Pre-existing architecture; fix = per-entity
  persistence. (UI mitigations landed: both sync buttons disable in flight.)
- `listTransactions(5000)` cap silently truncates insights inputs on big ledgers (no signal in payload).
- Plaid partial-page sync: pages persist mid-pagination, so a retry re-counts `added` and a failed sync may still
  have written data; plaid.mjs (unlike mock.mjs) doesn't mirror rows into the in-memory snapshot before writeDb.
- Plaid-specific error vocabulary lives in syncEngine.mjs rather than behind the adapter (documented tradeoff —
  plaid.mjs must not be modified); message-regex classification is fragile to rewording.
- Backend `humanizeSyncAge` duplicates frontend `humanizeTime` (kept: spec words the queue title server-side).
- JSON responses lack `; charset=utf-8` (browsers fine; PowerShell mojibake only).
- Chart polish: account-history series render as disconnected dots (needs `spanGaps`/point-radius), Demo Checking vs
  Roth IRA legend colors nearly identical, mobile x-axis single tick, budget y-axis duplicate "$1k/$0k" ticks,
  action-queue title ellipsis aggressive. Seeded *manual* accounts' deep history can go negative (seed balances never
  reconciled backward — cosmetic).
- Whole Foods/City Utilities price badges are legitimate per the algorithm (seeded linear drift compresses into a
  step); revisit if John finds grocery "subscriptions" noisy.

## Remaining spec work

- **Feature 4**: Orca automations — prompt files + DISABLED automations (`automation_nightly_prompt.md`,
  `automation_weekly_money_prompt.md`), created via `orca automations create --disabled --json`, tested via
  `orca automations run <id> --json`, enable commands handed to John at Gate 2. Never enable them yourself.
- **Feature 5**: polish & hardening — `node --test` suite covering registry/mock cursor/retry/detectors/import dedup
  (insights tests exist: backend/test/insights.test.mjs, 20 passing); security pass (tokens, provider inputs, CSV
  parsing); error/empty/loading states; extend qa-playwright.cjs (Connections health states are covered; add
  insights); README API table for every new endpoint.
- **End-of-run report**: Agent HQ report per team_run_prompt.md (`ObsidianVault\Reports\<date> Finance team.md` +
  Finance-team row), including the exact commands for when John's Plaid credentials arrive.

## When Plaid credentials arrive (John)

1. Put `PLAID_CLIENT_ID` + `PLAID_SECRET` in `backend/.env` (`PLAID_ENV=sandbox` default).
2. Restart: `node backend/src/server.mjs`.
3. Connections page → "check" (or `curl -X POST http://127.0.0.1:8787/api/providers/plaid/check`) — badge flips to
   "ready"; that is the entire setup.

## Hard lines (unchanged)

Node built-ins only; never enable automations without John; never commit `.env`/tokens/`data/*.sqlite`; never weaken
cryptoVault.mjs; additive migrations only; don't break existing endpoints, Apple Card import, or plaid.mjs.
