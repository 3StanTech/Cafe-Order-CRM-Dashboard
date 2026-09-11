# Release runbook

Followable release procedure for the order dashboard. Invents no commands. Apply migrations only by hand in the Supabase SQL Editor — never from CI, never from a script in this repo.

**No secret ever enters CI.** Netlify holds environment variables for the deployed app. GitHub Actions holds none; the `quality` workflow needs zero repository secrets.

**Public `/order` and OpenRouter Viber extraction are not live** until the manual activation steps below are finished. Shipping this branch, or merging it, does not turn them on.

---

## Public order and OpenRouter (not live until manual activation)

Do not treat customer `/order` or OpenRouter paste extraction as production behavior after a deploy. Both fail closed without host secrets and applied schema. Complete these only after a backup, in a maintenance window, and only when you intend to activate them.

### Public order submissions

Still off until all of the following are true:

1. Verify the owner-RLS prerequisite in production. In the Supabase SQL Editor, run `select public.dashboard_owner_uid();`. If it returns Angela’s uuid, continue. If it fails (function missing), take a backup, then hand-apply `supabase/migrations/20260828010000_owner_rls_and_aggregate_rpcs.sql` in a maintenance window. Do not assume this migration is already live.
2. Only after that query succeeds, hand-apply the additive pending-inbox migration `supabase/migrations/20260907010000_order_submissions.sql` in the Supabase SQL Editor, in its own transaction. It refuses to apply if `dashboard_owner_uid()` is missing. Never apply it from CI.
3. Netlify (or the equivalent host) has server-only `SUPABASE_SERVICE_ROLE_KEY`. Never put that value in `VITE_*`, GitHub Actions, or client source. The public page talks only to `/.netlify/functions/order-submissions`.
4. The host adapters (`netlify/functions/order-submissions.ts` and `api/order-submissions.ts`) are part of the deploy. They still fail closed without the service-role secret and the applied submissions migration.

Until those steps are done, `/order` must not be shared as a working customer link. A local Vite demo without functions also fails closed; that is not a production menu.

### OpenRouter Viber extraction

Still off until all of the following are true:

1. Netlify has `OPENROUTER_API_KEY` (server-only).
2. `OPENROUTER_MODEL` is a pinned id ending in `:free`, chosen after `npx --no-install jiti scripts/openrouter-benchmark.ts`. Do not invent a model id and do not use paid models or `openrouter/auto`.
3. Optional `OPENROUTER_FALLBACK_MODEL` is also a different pinned `:free` id, or omitted.
4. The existing authenticated `/.netlify/functions/parse-orders` deploy is serving the OpenRouter core.

Until those env vars are set, paste extraction returns HTTP 503 with a configuration message and makes no upstream call. A missing key is unresolved readiness, not a qualified free model.

---

## Preconditions (every release)

- A backup is taken **before any migration**. Follow [docs/BACKUP_RUNBOOK.md](BACKUP_RUNBOOK.md) (manual CSV or `pg_dump` as documented there). Do not skip this step.
- Working tree is clean and you are on the intended branch.

---

## Fixed sequence

### 1. Clean branch, clean `git status`

Confirm you are on the correct branch and that `git status` shows a clean working tree (or only the intentional changes for this release).

```sh
git status
```

### 2. Local quality gate

```sh
npm run check
```

This runs, fail-fast in order:

1. `npm run lint` — oxlint over `src server netlify api test e2e`. Gate is **zero errors**. The script does not pass `--deny-warnings`; the tree is currently also zero warnings.
2. `npm test` — unit/integration tests (vitest)
3. `npm run build` — TypeScript project build + Vite production build
4. `npm run check:bundle` — gzipped initial `/today` transfer vs the 220 KiB budget (`scripts/check-bundle.mjs`; needs `dist/` from the previous step)
5. `npm run test:e2e` — Playwright Chromium smoke in demo mode (`playwright.config.ts` force-blanks `VITE_SUPABASE_*` so a local `.env` cannot point the suite at production)

### 3. Open (or update) the PR — `quality` must be green

Push the branch and open a pull request. GitHub Actions workflow `.github/workflows/quality.yml` runs on pull requests and on pushes to `main`. Job name: **quality**.

Required steps (in order): checkout → Node 20 + npm cache → `npm ci` → Playwright Chromium install → `npm run lint` → `npm test` → `npm run build` → `npm run check:bundle` → `npm run test:e2e`.

Do not merge until the **quality** check is green.

### 4. Maintenance window

Schedule and announce a short maintenance window if the release includes a production database migration or any behavior that could disrupt operators mid-shift.

### 5. Record production baseline (pre-migration)

In the **Supabase SQL Editor**, run the contents of:

```text
supabase/checks/01_baseline.sql
```

Paste the single-row result (order count, order-item count, money sums, counts-by-status JSON) into the release record / changelog entry for this release.

### 6. Apply pending migration by hand

Apply the pending file under `supabase/migrations/` **by hand in the Supabase SQL Editor**, inside **its own transaction** (the migration file should begin with `begin;` and end with `commit;`, or wrap the body yourself).

The next unapplied production migration is `supabase/migrations/20260828010000_owner_rls_and_aggregate_rpcs.sql` (owner-bound RLS + aggregate RPCs). Confirm `select public.dashboard_owner_uid();` returns Angela’s uuid after apply. The shipped app falls back to the old multi-request path until this file has been applied, so production keeps working either way.

Public pending-inbox tables are a later additive file, `supabase/migrations/20260907010000_order_submissions.sql`. Do not apply it in the same breath as an unrelated frontend-only release, and do not treat `/order` as live merely because the file exists in git. See **Public order and OpenRouter** above.

- Never apply migrations from CI.
- Never apply migrations from a script in this repository.
- If anything fails before `commit`, roll back the transaction (see Rollback below).

### 7. Post-migration checks

In the Supabase SQL Editor, run again:

```text
supabase/checks/01_baseline.sql
supabase/checks/02_schema.sql
```

Compare invariants against the pre-migration record from step 5. Counts and money sums must match **exactly**, except where the migration intentionally changes them (document any intentional delta in the release record). Schema checks must show expected enum labels, required columns/constraints, and zero lifecycle-consistency violations (`orders_status_payment_inconsistent_count = 0`).

### 8. Merge / push `main`

Merge the PR (or push to `main` per your branching practice). Netlify auto-deploys from `main`.

### 9. Verify the deploy

1. Verify the deployed Netlify asset hash **byte-for-byte** against the local `npm run build` output (same method used for the last three releases). This comparison is only valid when the local build’s `VITE_SUPABASE_*` values (and optional `VITE_SENTRY_*`, if set in production) match Netlify production. A CI or blank-env build is **not** the production byte image — do not use it for the hash check.
2. Verify the PIN shell loads and accepts operator auth as expected.
3. Verify `/manifest.webmanifest` is served.
4. Verify `/sw.js` is served.
5. Open a clean browser console (hard refresh if needed) and confirm no unexpected errors.

### 10. Record the release

Record commit SHA, check results, baseline invariants (pre and post), and any intentional schema deltas in the project changelog.

---

## Rollback

- **Before a migration commits:** rollback is the SQL transaction rollback (`rollback;` in the Supabase SQL Editor). Do not leave a half-applied migration.
- **After a migration commits:** recovery is a **new forward migration** only. Never perform an ad-hoc manual rewrite of production data to “undo” a committed migration.

---

## Ordering rule

Frontend code that **requires** a schema change must not reach `main` before the compatible production migration is applied. Ship and apply the migration first (or in the same maintenance window before the frontend that depends on it is live), then promote the frontend.

---

## What CI does and does not do

| Does | Does not |
|------|----------|
| `npm run lint` | Apply database migrations |
| `npm test` | Hold or use repository secrets |
| `npm run build` | Deploy to production |
| `npm run check:bundle` | |
| Playwright E2E smoke (`npm run test:e2e`, demo mode) | |

Environment variables for the live app live in **Netlify**, not in GitHub Actions.
