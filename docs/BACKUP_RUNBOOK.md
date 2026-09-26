# Backup and restore runbook

**Live site:** https://bubu-cafe.netlify.app/

**New Supabase project:** `rcyhthbbexzsvtpjyptj` (Singapore, free tier)

**Current pre-migration baseline (2026-09-24):** `products=0`, `customers=0`, `orders=0`, `order_items=0`, `settings=1`, `modifier_groups=0`; `order_submissions` is absent. Re-run the read-only baseline immediately before migration because counts can change. Preserve and verify the existing Settings row in the private backup. Do not import the old project `ybmrdsnqquryrdiqglng` or browser-local demo records.

The database stores customer and order data once Release 1 is connected. The free plan does not provide point-in-time recovery. Keep one verified export outside the repository before Release 2's migration and maintain a regular backup cadence thereafter. Never put a connection string, PIN, API key, raw order details, or dump file in Git or chat.

## What to preserve

| Table | When it exists | Restore order | Notes |
|-------|----------------|---------------|-------|
| `products` | Release 1 | 1 | May be empty until the first legitimate catalog backfill; then six closed-catalog rows are expected. |
| `customers` | Release 1 | 2 | Parent for orders. |
| `orders` | Release 1 | 3 | References customers. Includes lifecycle and payment state. |
| `order_items` | Release 1 | 4 | References orders and products. Preserve JSON modifiers and snapshot prices. |
| `settings` | Release 1 | 5 | Contains runtime catalog and owner settings. Empty can be normal before first save. |
| `order_submissions` | Release 2 | 6 | Contains customer contact details and immutable submitted quotes; accepted rows may reference orders. |
| `order_confirmation_keys` | Release 2 | 7 | Durable idempotency tombstones; restore with operational data. |

`modifier_groups` is deliberately dormant and should stay empty. `order_submission_rate_limits` is transient rate-control state and need not be restored. Record both row counts in the manifest; investigate unexpected modifier rows rather than silently treating them as valid catalog data.

## When to back up

- After Release 1 passes with an empty or newly started database, capture the schema/check results as the baseline.
- Immediately before the Release 2 migration, save one verified data export from the new project. If there are no business rows, the schema is reproducible from reviewed SQL and the manifest should explicitly record zero counts.
- Immediately after the one-time history import, export again so the imported customers and orders are in a verified backup before customers start ordering.
- After activation, export at least monthly and immediately before later migrations or major releases.
- Store exports in a durable private location outside the project folder. A folder name such as `cafe-backup-YYYY-MM-DD` is sufficient; avoid redundant copies unless a second storage location is part of the recovery plan.

## Option A: Table Editor CSV export

1. Open [the new Supabase project](https://supabase.com/dashboard/project/rcyhthbbexzsvtpjyptj/editor) and confirm the project ref in the URL before exporting.
2. Export each existing, nonempty table in the order above into the dated backup folder. The Table Editor may refuse to export a zero-row table; record `0` in the manifest instead of creating a fake row.
3. Save a `MANIFEST.txt` outside Git with the date, new project ref, table names, row counts, filenames, and results of `supabase/checks/01_baseline.sql` and the applicable `03_fresh_project.sql` / `04_submissions.sql`. Do not include keys or customer data in the manifest.
4. Open each CSV to verify headers and plausible row counts. Ensure `orders` has matching `order_items` where orders exist. For Release 2, include both durable submission tables if they have rows; keep the folder private because the submissions CSV contains contact data.

CSV exports capture table data, not the complete database schema, SQL functions, policies, Auth passwords, or grants. The reviewed schema and migrations in this repository are part of the recovery set. Recreate the owner Auth account securely if rebuilding a whole project.

## Option B: PostgreSQL custom-format dump

A developer may use `pg_dump` if a connection string is available from the new project's Database settings. Keep the string in a local secret store and do not echo it or paste it into the repo. Save the dump outside the project folder, for example in a private backup directory. Use the installed Postgres client compatible with the server version.

```sh
pg_dump "$CAFE_SUPABASE_DATABASE_URL" --format=custom --file="$HOME/Backups/cafe/cafe-full-rcyhthbbexzsvtpjyptj-YYYY-MM-DD.dump"
```

The variable must be set in a private shell context; do not put its value in this runbook. Verify the file is nonempty and inspect the table-of-contents with `pg_restore --list` before relying on it. A database-wide dump may contain Supabase-managed schemas; plan any restore against a disposable project first rather than blindly restoring everything into production.

## Restore procedure

1. Stop writes to the app and public order endpoint. Confirm the target project and recovery point, then take a fresh snapshot of the current state if possible.
2. For a new empty project, apply the reviewed base `supabase/schema.sql` first, recreate the owner Auth account, then review and adapt `supabase/migrations/20260923010000_rebind_dashboard_owner.sql` to that new user's confirmed UID and email before applying it. Adapt the exact-UID assertion in `03_fresh_project.sql` to that new identity, run the check, and require the expected owner check to pass. Apply `supabase/migrations/20260907010000_order_submissions.sql` only if the backup includes Release 2 data. Do not apply the old owner-RLS migration to a fresh schema.
3. Restore CSV tables in the parent-before-child order above. Do not import `order_items` before both `orders` and `products`; do not import accepted `order_submissions` before `orders`. Preserve UUIDs and timestamps from the export. Rate-limit rows are regenerated and should not be imported.
4. Before using `pg_restore --clean` or overwriting any live table, inspect its object list and obtain explicit destructive-write authorization. This can drop live objects. Prefer a disposable restore drill to confirm compatibility.
5. Compare per-table counts, centavo sums and status counts with the manifest. Run `01_baseline.sql`, `02_schema.sql`, `03_fresh_project.sql`, and `04_submissions.sql` where applicable. In `03_fresh_project.sql`, `initial_operational_rows_empty` is only expected to pass before first use; compare restored row counts to the manifest instead. Validate owner sign-in and a representative order through the actual Supabase-backed app before resuming writes.

If a restore check fails, keep the site from taking new orders and investigate the mismatch. Do not improvise row deletions or reapply SQL blindly.
