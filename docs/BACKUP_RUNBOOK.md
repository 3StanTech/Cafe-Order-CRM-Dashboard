# Backup & export runbook

How to back up and restore the cafe order dashboard database. Written for a non-technical operator. No secrets belong in this file or in the git repo.

**Live app:** https://bubu-cafe.netlify.app/  
**Supabase project ref:** `ybmrdsnqquryrdiqglng` (free tier; RLS on all tables)

**Tables (restore-safe order — parents before children):**

1. `products`
2. `modifier_groups`
3. `customers`
4. `orders`
5. `order_items`
6. `settings`

---

## 1. What is at risk and why

All order and customer history for the live business lives in a single Supabase free-tier Postgres database. Free tier has **no point-in-time recovery (PITR)** — if data is deleted or corrupted, you cannot roll back to an earlier moment unless you already have a backup. The `products` table’s rows vanished once for unknown reasons and were only noticed when a production order failed to save. There is no automated backup. This document is the manual procedure until something better is set up.

---

## 2. Option A — Manual CSV export (recommended for the owner)

Do this from a browser. No command line required.

### Cadence

- **At least once a month**
- **Again immediately before every schema migration** (any change under `supabase/migrations/` applied by hand)

### Folder naming

On your computer (Desktop, iCloud Drive, Google Drive, or an external drive — **not** inside this project folder), create a folder named:

```text
cafe-backup-YYYY-MM-DD
```

Example: `cafe-backup-2026-07-28`

Keep that folder somewhere durable. Prefer a cloud drive or a second machine so a single laptop failure does not lose the only copy.

### Tap-by-tap export

1. Open [https://supabase.com/dashboard](https://supabase.com/dashboard) and sign in.
2. Open the project for this cafe (project ref `ybmrdsnqquryrdiqglng`).
3. In the left sidebar, click **Table Editor**.
4. For **each** table below, in this order:
   1. Click the table name in the left list.
   2. Wait until the rows load.
   3. Find the export control (often near the top right of the table view — a menu or **Export** / download action). Choose **Export as CSV** (wording may vary slightly by Supabase UI version).
   4. Save the file into your dated folder.
   5. Name each file clearly, for example:

| Order | Table | Suggested filename |
|------:|-------|--------------------|
| 1 | `products` | `01-products.csv` |
| 2 | `modifier_groups` | *skip — see note below* |
| 3 | `customers` | `03-customers.csv` |
| 4 | `orders` | `04-orders.csv` |
| 5 | `order_items` | `05-order_items.csv` |
| 6 | `settings` | `06-settings.csv` |

> **`modifier_groups` is expected to be empty — skip it.** The Table Editor
> refuses to export a table with no rows ("The table modifier_groups has no rows
> to export"); that is a UI limitation, not a failed backup. The table is
> vestigial: it has a full adapter CRUD surface but no caller anywhere in the
> app. The modifiers the app actually uses are hardcoded in
> `src/domain/contracts.ts` and assigned per product in `src/domain/catalog.ts`,
> and each cup's chosen options are stored as jsonb on `order_items.modifiers`,
> which `05-order_items.csv` already captures. Record it in `MANIFEST.txt` as
> `modifier_groups=0 (expected, table unused)` and move on. If this table ever
> does contain rows, stop and find out what wrote them before proceeding.

5. Confirm the dated folder contains **five** CSV files before you close the
   browser (six tables, minus the skipped `modifier_groups`).

If the UI has changed and you cannot find Export, use the table’s overflow menu (⋯) or check Supabase’s current docs for “export table CSV” — do not invent SQL or CLI steps for Option A.

---

## 3. Option B — `pg_dump` (for a developer)

Use this only if you are comfortable with a terminal and Postgres tools. The owner can stick to Option A.

### Connection string (never commit it)

1. Supabase Dashboard → project → **Project Settings** → **Database**.
2. Copy the **connection string** (URI) from there.
3. Treat it as a secret. **Never** paste it into this repo, into a committed `.env`, into a PR, or into chat logs that get archived. Prefer pasting it only into your local terminal session, or into a local secret store outside git.

Placeholders used below:

- `<CONNECTION_STRING_FROM_SUPABASE_DASHBOARD>` — the URI from Project Settings → Database  
- `<YOUR_PROJECT_REF>` — e.g. `ybmrdsnqquryrdiqglng`  
- Store dump files **outside** the git repo (e.g. `~/Backups/cafe/` or an external drive).

### Full dump (schema + data)

```sh
pg_dump "<CONNECTION_STRING_FROM_SUPABASE_DASHBOARD>" \
  --format=custom \
  --file="$HOME/Backups/cafe/cafe-full-<YOUR_PROJECT_REF>-YYYY-MM-DD.dump"
```

### Data-only dump

```sh
pg_dump "<CONNECTION_STRING_FROM_SUPABASE_DASHBOARD>" \
  --data-only \
  --format=custom \
  --file="$HOME/Backups/cafe/cafe-data-<YOUR_PROJECT_REF>-YYYY-MM-DD.dump"
```

Replace `YYYY-MM-DD` with the real date. Create `$HOME/Backups/cafe/` first if it does not exist. Do not place dump files under the `order-dashboard` project directory.

---

## 4. Restore procedure

**Warning:** Restoring into a live database can break foreign keys if tables are loaded out of order. Prefer restoring during a maintenance window when no one is taking new orders. If you are unsure, get a developer involved before writing to production.

### Foreign-key order (why it matters)

- `order_items.order_id` **cascades** when an order is deleted (`orders` → `order_items`).
- `orders.customer_id` does **not** cascade from `customers`. Customers must exist before orders that reference them.
- `order_items` also references `products`. Products must exist before order items.

Always load **parents before children**:

1. `products`
2. `modifier_groups` — normally nothing to load; no CSV is exported for it (see section 3)
3. `customers`
4. `orders`
5. `order_items`
6. `settings`

### From Option A (CSV)

1. Open Supabase → **Table Editor**.
2. If you are replacing bad or missing data, decide per table whether you need to clear conflicting rows first. Deleting live rows is irreversible without a backup — stop if unsure.
3. Import each CSV in the restore-safe order above (table → import/insert from CSV if available in the UI).
4. Do **not** import `order_items` before `orders` and `products`, or `orders` before `customers`. Out-of-order imports commonly fail with foreign-key errors or leave half-restored data.
5. After all **five** CSVs are imported (`modifier_groups` skipped — empty/unused, no export), run the verification checks in section 5.

Exact import click labels vary by Supabase version. If bulk CSV import is unavailable in the Table Editor for your project, a developer should use the SQL editor or Option B tools rather than guessing.

### From Option B (`pg_dump`)

Full custom-format dump (restores schema + data as packaged by `pg_dump`):

```sh
pg_restore \
  --dbname="<CONNECTION_STRING_FROM_SUPABASE_DASHBOARD>" \
  --clean \
  --if-exists \
  "$HOME/Backups/cafe/cafe-full-<YOUR_PROJECT_REF>-YYYY-MM-DD.dump"
```

Data-only restore (schema already exists):

```sh
pg_restore \
  --dbname="<CONNECTION_STRING_FROM_SUPABASE_DASHBOARD>" \
  --data-only \
  --disable-triggers \
  "$HOME/Backups/cafe/cafe-data-<YOUR_PROJECT_REF>-YYYY-MM-DD.dump"
```

`--clean` drops existing objects before recreate — that is destructive on a live project. Confirm the target and take a fresh backup first. Prefer a developer for production restore.

If restoring table-by-table from SQL or CSV instead of a single dump, still use the parent-before-child order above.

---

## 5. Verification

A backup is only useful if it actually contains data. After every export (and after every restore), check:

### CSV (Option A)

1. Open each file in a spreadsheet app or text editor.
2. Confirm it is **not** empty (more than just a header row, unless that table truly has zero rows).
3. Sanity-check approximate row counts against what you see in Supabase Table Editor for the same day:

| Table | Sanity check |
|-------|----------------|
| `products` | **Exactly six** rows for the closed catalog. **More than six** means extra rows exist under different names — treat that as a known open item and investigate; do not silently “fix” by deleting without a plan. **Fewer than six** may mean catalog loss (the failure mode that already happened once). |
| `modifier_groups` | **Expected empty — no CSV file.** Confirmed 2026-07-29: the table is unused by the app. Rows appearing here are a signal to investigate, not a backup to verify. |
| `customers` | Roughly matches the customer list you expect (order of magnitude is enough). |
| `orders` | Roughly matches order history volume. |
| `order_items` | Should be **at least** as many rows as orders (usually more). Zero items with many orders is wrong. |
| `settings` | Usually a small fixed set of rows; empty may mean defaults only or a problem — compare to Table Editor. |

4. Optionally write the counts into a one-line `MANIFEST.txt` in the same dated folder, e.g. `products=6 modifier_groups=0 (expected, table unused) customers=… orders=…`.

### `pg_dump` (Option B)

1. Confirm the dump file size is not zero.
2. Optionally list contents: `pg_restore --list path/to/file.dump | head` (should show tables/data, not an empty listing).
3. After restore, compare row counts in Table Editor (or SQL `count(*)`) to the pre-restore numbers you recorded.

---

## 6. Pre-migration checklist

Run this **before** applying any versioned SQL file from `supabase/migrations/` by hand in a maintenance window:

1. [ ] Tell anyone who uses the dashboard that orders will pause for the window.
2. [ ] Complete a full Option A CSV export into a new `cafe-backup-YYYY-MM-DD` folder — five files, since `modifier_groups` is expected empty and is skipped (and/or Option B dump if a developer is present).
3. [ ] Verify the backup (section 5) — especially `products` = 6 and non-empty `orders` / `order_items` if you had production traffic.
4. [ ] Note the migration filename you will apply and keep it open side by side with this checklist.
5. [ ] Prefer applying migrations only when you can stay at the computer until verification finishes.
6. [ ] After the migration: spot-check Table Editor row counts, try loading the live app (https://bubu-cafe.netlify.app/), and confirm a sample order still looks correct.
7. [ ] If anything looks wrong: **stop**, do not run further SQL, and restore from the backup you just made (section 4).

Migrations in this project are applied **manually**; this checklist is not automated.

---

## 7. What is explicitly out of scope

This document only records **manual** backup and restore steps.

**Not set up by this runbook:**

- Scheduled / automated backups
- Supabase paid-tier PITR (point-in-time recovery)
- GitHub Actions or cron jobs that dump the database
- Off-site replication or multi-region failover

**What it would take to automate later (notes only — do not implement from this file):**

- Upgrade off free tier if PITR is required, **or**
- A scheduled job (e.g. monthly cron or CI) that runs `pg_dump` with a secret connection string stored outside git, writes dated files to encrypted object storage, and alerts if the job fails or file size is zero
- Periodic restore drills so the procedure is proven, not only written down

Until then: monthly CSVs + a backup before every migration are the safety net.

---
