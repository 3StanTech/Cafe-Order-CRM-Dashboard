# Gelly Dashboard Improvement Roadmap

**Status (2026-09-11): complete.** Phases 1–4 shipped (lint/CI/e2e, bundle split, lifecycle timestamps, Sentry). Do not restart this document. Current state lives in the project `master.md`. Cafe intake activation is a separate checklist: `Gelly_Production_Activation_Guide.docx`.

**Prepared:** 2026-07-28

**Purpose:** Decision-complete session transfer for the approved “Do immediately” and “Do later” improvements.

**Current production baseline:** commit `1cf0dee`; live at <https://bubu-tracker.netlify.app/>; `New → Paid → Delivered` with `Cancelled` as a terminal exception; 159/159 Vitest tests passing; production build passing; 16 source lint warnings; largest application bundle approximately 559 KB.

## Read this first

1. Read the project-level `master.md`, then this roadmap.
2. Work from a feature branch and preserve unrelated user changes.
3. Complete the phases in order. Each phase gets its own focused pull request and release record.
4. Never use production customer/order data for automated tests. Browser E2E runs only in demo mode.
5. Database changes remain versioned in Git and manually applied through Supabase SQL Editor during a maintenance window.
6. Do not begin a later phase until the preceding phase meets its definition of done in production.

## Approved decisions and priorities

| Phase | Improvement | Timing | Expected ROI | Effort | Primary risk | Scalability |
|---|---|---|---|---|---|---|
| 1 | Lint gate and zero-warning cleanup | Do immediately | Medium | Low | Accidental behavior changes during file moves | Medium–high |
| 1 | Repeatable browser E2E smoke test | Do immediately | High | Medium | Flaky selectors or accidental production access | High |
| 1 | CI and formal database/release checks | Do immediately | High | Low–medium | A gate that exists but is bypassed | High |
| 2 | Route/vendor bundle splitting | Do later | Medium | Medium | Lazy-load or PWA-cache regressions | High |
| 3 | Visible paid/delivered timestamps | Do later | Medium–high | Medium | Incorrect historical backfill or adapter drift | High |
| 4 | Minimal Sentry error monitoring | Do later | High | Low–medium | PII leakage, noisy events, or exposed build secrets | High |

The roadmap deliberately excludes POS/payment processing, route optimization, and multi-role permissions.

## Phase 1 — Immediate reliability foundation

### 1.1 Add a strict lint gate and clear all 16 source warnings

- Add package scripts:
  - `lint`: run Oxlint only over owned source/test directories (`src`, `server`, `netlify`, `api`, `test`, `e2e`) with `--deny-warnings`.
  - `test:e2e`: run Playwright’s Chromium project.
  - `check`: run `npm run lint`, `npm test`, `npm run build`, then `npm run test:e2e` in fail-fast order.
- Clear warnings without disabling rules:
  - Move `relevantDeliveryDate` out of `TodayBoard.tsx` into a colocated non-component utility module.
  - Move `formatPhp` and `cupCount` out of `OrderCard.tsx` into a colocated display utility module.
  - Move `blankItem`, `blankBag`, `updateItem`, and `setCupName` out of `OrderEditorCard.tsx`; keep React-only exports in the component file.
  - Remove the unnecessary `catalog` dependency from the validation `useMemo`; catalog rendering remains unchanged.
  - Remove only the unnecessary escaped double quotes in import-parser messages; preserve exact user-facing wording.
- Do not lint generated `dist`, `dev-dist`, Playwright output, dependencies, or coverage artifacts.
- Update affected imports/tests only; do not perform unrelated formatting or refactors.

**Acceptance:** `npm run lint` reports zero warnings and zero errors, existing unit/component behavior is unchanged, and the complete `npm run check` command passes.

### 1.2 Add a demo-only Playwright smoke suite

- Add `@playwright/test`, `playwright.config.ts`, and `e2e/smoke.spec.ts`.
- Configure one Chromium project at the product’s mobile target: viewport `390 × 844`, locale `en-PH`, timezone `Asia/Manila`, one worker in CI, no retries locally, two retries in CI, trace/screenshot/video retained only on failure.
- Let Playwright start Vite with `--mode demo --host 127.0.0.1` on a fixed dedicated port. Explicitly pass empty `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values so a developer’s local `.env` cannot redirect the test to production.
- Use accessible roles/labels and stable product text; do not select elements by CSS classes or source position.
- Cover one deterministic smoke path:
  1. Open `/today`, set the delivery date to the seeded `2026-07-16` run, and assert the demo banner plus New/Paid/Delivered board sections.
  2. Advance the seeded New order to Paid and then Delivered; verify its section, action button, and payment-dependent state after each transition.
  3. Cancel the other seeded Paid order, confirm Delivered and Cancelled are terminal, and verify the cancelled order is excluded from the delivery run.
  4. Visit Orders, Customers, Insights, Import, and Settings through the visible navigation; assert each page heading and no error banner.
  5. Verify the manifest is linked and `/manifest.webmanifest` plus `/sw.js` return successfully.
  6. Fail the test on uncaught page errors or unexpected console errors.
- Keep this suite intentionally small. Existing Vitest tests remain the exhaustive behavioral layer.

**Acceptance:** the smoke passes headlessly on a clean machine and in CI, touches no Supabase account, and produces actionable artifacts on failure.

### 1.3 Add GitHub Actions and a reusable release runbook

- Add `.github/workflows/quality.yml` for pull requests and pushes to `main`:
  1. Check out the repository.
  2. Set up Node 20 with npm cache.
  3. Run `npm ci`.
  4. Install the matching Playwright Chromium binary and Linux dependencies.
  5. Run `npm run check`.
  6. Upload Playwright artifacts only when the E2E step fails.
- Enable GitHub branch protection for `main`: require a pull request and the `quality` check before merge. Netlify remains configured to auto-deploy `main`; do not put Supabase or Sentry secrets in the CI workflow.
- Add `docs/RELEASE_RUNBOOK.md` and versioned read-only SQL under `supabase/checks/`:
  - Baseline query returns order count, order-item count, subtotal, delivery-fee total, grand total, and JSON counts by status in one row.
  - Schema query returns enum labels, required constraints/columns, and lifecycle consistency results.
  - Runbook sequence is fixed: clean branch → local `npm run check` → PR quality gate → maintenance window → record production baseline → apply pending migration transaction → run postflight and compare invariants → merge/push `main` → verify Netlify bundle/PIN shell/PWA endpoints/console → record commit and results.
  - Before a migration commits, rollback is the transaction rollback. After commit, recover only with a new forward migration; never manually rewrite production data ad hoc.
  - Frontend code that requires a schema change must not reach `main` before the compatible production migration is applied.
- Update README commands and ignore Playwright output/report directories.

**Acceptance:** a clean PR proves lint, 159+ Vitest tests, build, and demo E2E; the runbook can be followed without inventing commands or queries; no secret or production credential is present in GitHub Actions.

## Phase 2 — Bundle splitting and performance budget

- Convert the six route pages in `App.tsx` to `React.lazy` imports and wrap the route outlet with one accessible Suspense loading state. Keep `AuthBoundary`, `AppShell`, the demo banner, and install prompt eager.
- Add deterministic Rollup chunk groups in Vite:
  - `framework`: React, React DOM, and React Router.
  - `supabase`: Supabase client packages.
  - Feature pages remain separate lazy route chunks.
- Add `scripts/check-bundle.mjs` after the production build. It reads emitted JavaScript assets, prints their byte sizes, and fails if any single JavaScript chunk exceeds 300 KiB uncompressed.
- Add `check:bundle` after `build` in both `npm run check` and CI.
- Keep all generated chunks in the PWA precache. Verify a deployed update replaces the old service worker and that the app opens offline after one successful online load.
- Do not add a general loading framework or change page design.

**Acceptance:** no JavaScript chunk exceeds 300 KiB uncompressed, the initial Today route does not load code for the other five feature pages, all routes render through direct navigation and client navigation, and the PWA update/offline smoke remains green.

## Phase 3 — Visible lifecycle timestamps

### Data and interface contract

- Extend `StoredOrder` with required nullable fields:
  - `paidAt: string | null`
  - `deliveredAt: string | null`
- Map them to `orders.paid_at` and `orders.delivered_at` in both Supabase serialization directions. Local/demo records and all fixtures must explicitly include both fields.
- New orders start with both values `null`.
- `New → Paid` atomically writes `status: 'paid'`, `paymentReceived: true`, and `paidAt: now`.
- `Paid → Delivered` atomically writes `status: 'delivered'` and `deliveredAt: now`; it never rewrites `paidAt`.
- Cancelling preserves whichever timestamps already exist. Editing or repeating an order must not fabricate or overwrite lifecycle timestamps.

### Migration and constraints

- Add `20260728010000_add_order_lifecycle_timestamps.sql` and update the fresh-install schema.
- In one transaction, add both nullable `timestamptz` columns and backfill historical rows:
  - New: both null.
  - Paid: `paid_at = updated_at`, `delivered_at = null`.
  - Delivered: both timestamps use `updated_at` because the exact historical transition times were not previously recorded.
  - Cancelled with `payment_received = true`: `paid_at = updated_at`; otherwise both null.
- Document these historical values as approximations. All timestamps created after deployment are exact client transition times.
- Add a lifecycle timestamp constraint:
  - New requires both null.
  - Paid requires `paid_at` and forbids `delivered_at`.
  - Delivered requires both and `paid_at <= delivered_at`.
  - Cancelled may retain `paid_at` but must not have `delivered_at`.
- Migration assertions must preserve order/item counts and monetary totals and reject any row that violates payment or timestamp consistency.

### UI

- Centralize display formatting using `en-PH` and `Asia/Manila`.
- Show “Paid …” and “Delivered …” metadata on order cards/history and customer order history only when values exist. Do not add new controls or a standalone audit screen.

**Acceptance:** adapters round-trip both fields, realtime updates carry them, transition tests prove timestamps are set once and preserved, migration tests cover every status/backfill branch and rollback, production pre/post totals match, and the timestamps render correctly on mobile.

## Phase 4 — Minimal privacy-scrubbed Sentry monitoring

- Create a Sentry browser project and add `@sentry/react` plus `@sentry/vite-plugin`.
- Initialize monitoring before React renders only when `VITE_SENTRY_DSN` is present. Demo, tests, and developer builds without the DSN send nothing.
- Configuration is deliberately minimal:
  - Error capture only; tracing and Session Replay disabled.
  - `sendDefaultPii: false`.
  - A tested `beforeSend` sanitizer removes user identity, request headers/cookies/query strings, form data, arbitrary `extra`, and breadcrumb payload data.
  - Never attach customer names, phones, addresses, order notes, raw imported messages, PIN values, or order objects.
  - Tag only deployment environment and commit/release identifier.
- Add a React error boundary with a branded generic failure screen and reload action. It may report the exception but must not expose technical details to the client.
- Generate hidden production source maps and upload them during Netlify builds with `@sentry/vite-plugin`. Store `SENTRY_AUTH_TOKEN`, organization, and project identifiers only in Netlify; delete emitted `.map` files after upload. The public DSN may be a Vite variable, but no auth token may appear in the client bundle or Git history.
- Configure one alert for a new production error or a regression. Do not enable logs, performance monitoring, user feedback, replay, or AI add-ons.
- Validate with unit tests for DSN gating/sanitization/error fallback and one synthetic, non-PII unhandled error on the deployed PIN shell; confirm it reaches the correct Sentry release, then resolve the test issue.

**Acceptance:** real unhandled errors appear with usable source-mapped stacks and the correct commit, the synthetic event contains no business/customer data, the app remains functional when Sentry is blocked, and no monitoring secret ships to the browser.

## Required gates for every phase

- `npm run lint` — zero warnings/errors.
- `npm test` — all existing and new Vitest tests pass.
- `npm run build` and `npm run check:bundle` once Phase 2 exists.
- `npm run test:e2e` at 390 × 844 in demo mode.
- Clean Git status except the intended phase files.
- For database phases: migration parser tests, recorded production pre/post invariants, and a non-mutating deployed verification.
- For releases: GitHub quality check green, exact deployed asset tied to the commit, PIN shell/PWA endpoints healthy, and no browser-console errors.

## Session handoff template

At the end of each implementation session, append a short entry to the project-level `master.md` and report:

- Phase and completed deliverables.
- Branch, commit, and pull-request/deploy status.
- Unit, lint, build, bundle, E2E, and production-verification results.
- Database migration status and before/after invariants, if applicable.
- Remaining warnings/defects and the exact next phase/step.
- Any external account action still required from the user.

## References

- [Playwright configuration and `webServer`](https://playwright.dev/docs/api/class-testconfig)
- [Playwright installation and CI guidance](https://playwright.dev/docs/intro)
- [Sentry React documentation](https://docs.sentry.io/platforms/javascript/guides/react/)
- [Sentry Vite source-map upload](https://docs.sentry.io/platforms/javascript/guides/react/sourcemaps/uploading/vite/)
