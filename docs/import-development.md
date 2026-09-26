# Intake development

Orders reach the dashboard three ways: customers submit the public `/order` form and the owner accepts them from the **Inbox**; the owner enters Viber-only orders with **New order** or **Repeat**; and past delivered orders enter once through **Settings → Import history**. Every path prices through `priceOrder()` in `src/domain/pricing.ts`. No path trusts a price supplied by a customer, a file, or the browser. Public ordering is not live in production until the steps in [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) are complete.

## Public `/order`

The form loads its menu, payment instructions, and delivery options from the order-submissions function (`server/order-submissions-core.ts`, thin Netlify and Vercel adapters). Delivery options are every open day in the next seven Manila calendar days after the order cutoff, minus owner-closed dates (`getAvailableDeliveryDates` in `src/domain/delivery-schedule.ts`). The customer picks one; the server accepts only a date in the current option set. If every day in the window is closed but a later day exists, the menu reports that ordering is paused until that date.

The quote revision is a hash of the whole settings row, so any change to prices, open days, closed dates, or the cutoff forces a reconfirmation. When the chosen day disappears, the form moves the customer to the first offered day and asks them to review before submitting again.

Controls that must stay in place: the honeypot field, the per-IP rate limit (`consume_order_submission_rate_limit`), the idempotency key with request-hash comparison, the 64 KiB body cap, the strict key whitelist, and the quote-revision and total check. The function fails closed without its server key or the submissions migration. It never exposes anonymous table access.

## Inbox

Pending submissions live in `order_submissions` until the owner accepts or rejects them (`src/features/import/PendingInbox.tsx`, rendered by the Inbox tab). Accept creates a New, unpaid order through `accept_order_submission`; Mark Paid on Today remains the only payment action. The owner may edit a pending submission before accepting. The server re-prices the edit, and a changed delivery date must be one of the currently offered days. Contact details stay on the submission so a Viber reply can be copied. The Today board shows a banner linking to the Inbox while submissions are waiting.

## Schedule

Open weekdays, closed dates, cutoff, and delivery window are owner settings stored in the single `order_dashboard_settings` row (`src/features/settings/settings-store.ts`). Closed dates are Manila `YYYY-MM-DD` strings, de-duplicated, sorted, capped at 60, and pruned of past dates on save. The Today, Orders, and Customers screens read the same settings through `useDashboardSettings` and `getRelevantDeliveryDate`; no screen hardcodes delivery weekdays.

## History import

`/settings/import-history` is a lazy-loaded, owner-only page for bringing in past delivered orders once. It reads a JSON Lines file locally in the browser (nothing is uploaded until an order is confirmed). Each line is one past order:

```json
{"source_ref":"sheet row 14","customer_name":"Mika Santos","customer_phone":"09171234567","delivery_date":"2026-07-15","address":"Makati City","items":[{"product_slug":"matcha-latte","quantity":1,"level":2,"powder":"yumeno","sweetness":"light","cup_names":[]}],"thermal_bags":[{"covered_cup_count":1}],"notes":null}
```

`source_ref`, `customer_name`, a past-or-today `delivery_date`, and at least one item are required. Price and total fields are ignored if present. Cancelled orders are not imported.

Each order is confirmed through the same durable path as other intake (`confirmImportDraft` → `create_order_with_confirmation`), which re-prices through `priceOrder()` and resolves the customer by name and phone. It is then advanced New → Paid → Delivered with the same patches the lifecycle buttons use. The client never supplies `paid_at` or `delivered_at`: the database trigger stamps them at import time, and the app shows **Imported** instead of those times for any order whose `raw_source` starts with `history-import:`. Insights and customer statistics use `delivery_date`, so imported history lands in the correct weeks.

The import is resumable. A retry reuses the stored confirmation snapshot, gets the same order back, and continues advancing from its current status. Lines whose `source_ref` was already imported are flagged in the preview.

## Parked text extraction

The OpenRouter extraction function (`server/parse-orders-core.ts`, `server/openrouter.ts`) remains deployed but unconfigured and has no client entry point. Unsigned requests return 401; signed requests return 503 until `OPENROUTER_API_KEY` and a pinned `:free` `OPENROUTER_MODEL` are set. `scripts/openrouter-benchmark.ts` is the qualification harness; with no key it prints unresolved readiness and makes no network call. Re-enabling extraction needs a new client entry point and a passing benchmark.

## Offline tests

Tests never call external services. Mock `fetch` with `vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))`. The unit suite runs against `LocalAdapter`, which tolerates things Postgres does not, so any new persistence path also needs a `SupabaseAdapter` test built on `src/data/__tests__/fake-postgrest.ts`.
