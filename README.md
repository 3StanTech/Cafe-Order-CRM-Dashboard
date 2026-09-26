# Order Dashboard

A mobile-first React order dashboard for a Metro Manila matcha cafe.

## Requirements

- Node.js 20+
- npm

## Commands

```sh
npm run dev -- --mode demo
npm run dev
npm run lint
npm test
npm run build
npm run check
npm run test:e2e
npm run preview
```

`npm run dev -- --mode demo` runs offline against in-browser storage with no environment variables. Plain `npm run dev` uses the Supabase project named in `.env`, which is production data.

- Release and activation checklist: [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md)
- Database backup procedure (manual CSV / pg_dump): [docs/BACKUP_RUNBOOK.md](docs/BACKUP_RUNBOOK.md)
- Order intake (public order form, Inbox, history import): [docs/import-development.md](docs/import-development.md)

The app starts in demo-safe mode: no environment variables are required and no secrets are included in client code. Monetary values use integer centavos and should be displayed with `formatPesos`, which formats PHP using `en-PH`. Future price values must be produced by a deterministic pricing engine, never an LLM.
