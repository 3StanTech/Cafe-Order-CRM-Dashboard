# Import pipeline development

Intake is two paths into one review surface. Viber paste stays on Import. Public `/order` submissions land in the same pending inbox once that host path is activated. Neither public ordering nor OpenRouter extraction is live in production until the manual steps in [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md).

## Viber paste

Paste ordinary Viber messages into Import and create drafts. Free-form text is the primary path. It is sent only to `/.netlify/functions/parse-orders` with the operator Bearer token. The function requires `OPENROUTER_API_KEY` and a pinned `OPENROUTER_MODEL` ending in `:free`; without those it returns HTTP 503. Paid models and `openrouter/auto` are rejected before any upstream call. The provider is asked for structure only. Client-side normalization uses the explicit alias map, then `priceOrder` from `src/domain/pricing.ts` for every draft. Source monetary claims are never read.

`parseLocalInput` still decides JSON / JSON Lines before the component can call `fetch`, so a valid JSON import stays offline. The copyable `@ChatGPT-in-Viber` prompt remains a secondary recovery tool, not the daily path.

## Confirm selected

Valid drafts are confirmed together. Unresolved required fields block confirmation; nonblocking warnings stay visible. Each result is handled individually: successes leave the working set, failures stay with an actionable error. Confirmation goes through `confirmImportDraft` → `adapter.confirmOrderWithResolution` only. There is no `createCustomer` / `createOrder` fallback, because those separate writes can orphan a customer or duplicate an order after an uncertain retry.

The first attempt stores a durable confirmation key and an exact `confirmationSnapshot`. A retry must reuse that snapshot. If the draft identity changed after the attempt, persist throws the restore-original message instead of minting a new order.

## Pending inbox

Public `/order` submissions are not operator drafts. They wait in `order_submissions` until Angela accepts or rejects them. The intended Import inbox shows a pending count, refreshes while visible, and accepts selected rows into New unpaid operational orders. Only the existing Mark Paid action records payment. Contact details stay on the submission so a Viber reply can be copied. This inbox is not live until the additive submissions migration is applied by hand and the server-only service role is configured on the host.

## Seven-day recovery

Unfinished paste text, drafts, and in-progress confirmation snapshots are stored owner-scoped in `localStorage` under `gelly-import-recovery:` (`src/features/import/draft-recovery.ts`). Snapshots expire after seven days (`IMPORT_RECOVERY_TTL_MS`). Corrupt structured payloads are cleared. Blocked storage returns null and does not throw. A failed clone clears the snapshot rather than returning a partial workspace. Sign-out should call `clearImportWorkspace` so another person on the same browser does not recover Angela’s paste.

## Offline test stub

Tests must not call OpenRouter. Mock the endpoint with `vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ orders: [...] }), { status: 200 })))`. The existing parser tests cover the local path without a fetch call. The realistic threads used by manual/extraction tests are in `test/fixtures/import/builder/viber-threads.ts`.

Free-model qualification is `npx --no-install jiti scripts/openrouter-benchmark.ts`. With `OPENROUTER_API_KEY` unset it prints unresolved readiness, writes a local result file (path from `--out`, `OPENROUTER_BENCHMARK_OUT`, or a relative default), and exits 0 without a network call.

## Manual browser check

Operator Import (demo, no functions):

```sh
npm run dev -- --mode demo --host 127.0.0.1 --port 5176
```

At 390 by 844, paste a short Viber thread (or JSON fixture content) and review the compact draft before confirming. JSON must not issue a `parse-orders` request. Change a level and confirm the displayed amount changes. Confirm selected and inspect `adapter.listOrders()` from a test/script. The bottom navigation remains visible on the mobile viewport.

Public `/order` is a separate unauthenticated page. `npm run dev -- --mode demo` does **not** serve `/.netlify/functions/order-submissions`, so the form fails closed with “Online ordering is unavailable.” That is accurate, not a stub menu.

To review the real public form against an isolated loopback database (never production), map `API_URL` / `ANON_KEY` / `SERVICE_ROLE_KEY` from a private `supabase status -o env` capture into `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` without printing them, then:

```sh
npx --no-install netlify functions:serve --port 9999
LOCAL_ORDER_FUNCTIONS_URL=http://127.0.0.1:9999 npm run dev -- --host 127.0.0.1 --port 5176
```

Vite proxies `/.netlify/functions` only when `LOCAL_ORDER_FUNCTIONS_URL` is set. The function still prices through `priceOrder`. Do not treat that local receipt as production activation.
