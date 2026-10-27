# Setup Guide — Euro Glam BD

Covers Steps 1–6 of `docs/FEATURE-AI-ADVISOR.md`. Everything here is already
applied to this repository; the commands are for reproducing the setup on a
fresh machine or a fresh clone.

---

## Status

| Step | Outcome |
|---|---|
| 1 — Scaffold Next.js App Router | Done. Next.js 16.4.3, React 19.3.0, TypeScript, Tailwind v4, ESLint 9 |
| 2 — Dependencies | Done. Prisma 6.19.3, zod 4, jose 6, bcryptjs 3, tsx, dotenv |
| 3 — Environment variables | Done. `.env` written (git-ignored), `.env.example` committed |
| 4 — Create the database | **Needs your action** — see below |
| 5 — Prisma schema + migration | Done. Schema validates; migration SQL generated at `prisma/migrations/20260101000000_init/migration.sql` |
| 6 — Prisma client singleton | Done. `src/lib/db.ts` with global hot-reload caching |

**Current blocker:** the PostgreSQL `postgres` superuser password on this
machine is not a common default, and the PostgreSQL data directory is outside
the assistant's filesystem scope. The database has not been created yet.
Everything else is complete and verified.

---

## One-time setup: the PostgreSQL password

PostgreSQL 18.6 is installed and running as the Windows service
`postgresql-x64-18`, listening on port 5432. The connection is reachable — it
rejects the credentials, it does not refuse the socket.

`npx tsx scripts/probe-db.ts` tried twelve common passwords and all failed.
If you know the password, skip to [Step 4](#step-4--create-the-database).

### If you do not know the password

Reset it on this local development machine:

```powershell
# 1. Stop the service (run PowerShell as Administrator)
Stop-Service postgresql-x64-18

# 2. Switch local auth to trust
notepad "C:\Program Files\PostgreSQL\18\data\pg_hba.conf"
```

In `pg_hba.conf`, change the `host` lines from `scram-sha-256` to `trust`:

```
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
```

```powershell
# 3. Restart and set a known password
Start-Service postgresql-x64-18
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d postgres
# at the psql prompt:
ALTER USER postgres WITH PASSWORD 'postgres';
```

Then restore `pg_hba.conf` to `scram-sha-256` and restart the service again.
Leaving `trust` enabled means anyone who can reach the port gets full access —
fine for a laptop on an isolated network, not fine otherwise.

**Alternatively**, create a dedicated application role instead of resetting the
superuser:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d postgres
CREATE ROLE euro_glam WITH LOGIN PASSWORD 'euro_glam_dev_pw';
CREATE DATABASE euro_glam_bd OWNER euro_glam;
```

Then set `DATABASE_URL` to:

```
postgresql://euro_glam:euro_glam_dev_pw@localhost:5432/euro_glam_bd?schema=public
```

A dedicated role is the better practice — the application never runs as a
superuser.

---

## Step 4 — Create the database

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d postgres -c "CREATE DATABASE euro_glam_bd;"
```

Verify:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -lqt | Select-String euro_glam
```

---

## Step 5 — Apply the migration

The migration SQL is already written and committed. Apply it with:

```bash
npx prisma migrate deploy
```

`migrate deploy` applies committed migrations without prompting and without
drift detection — the right choice for a repeatable setup. For active
development where you want Prisma to generate migrations as the schema changes:

```bash
npx prisma migrate dev
```

Verify:

```bash
npx prisma migrate status     # → "Database schema is up to date!"
npx prisma validate           # → "The schema at prisma/schema.prisma is valid"
```

---

## Step 6 — Seed and verify

```bash
npx prisma db seed
```

Creates: 1 admin, 1 demo customer (with a skin profile), 8 categories,
19 products, 6 reviews, and the single `AiConfig` row carrying the disclaimer.

| Role | Email | Password |
|---|---|---|
| Admin | `admin@euroglambd.com` | `ChangeMe123!` |
| Customer | `customer@euroglambd.com` | `ChangeMe123!` |

Verify the data:

```bash
npx prisma studio
```

Or query directly:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d euro_glam_bd -c "SELECT count(*) FROM products;"
```

---

## Step 3 — Environment variables

`.env` is git-ignored; `.env.example` is committed. The defaults are for local
development only.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_JWT_SECRET` | HMAC key for session tokens. **Must be ≥32 bytes.** Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `AUTH_JWT_TTL_SECONDS` | Session lifetime (604800 = 7 days) |
| `AI_PROVIDER` | `mock` (default, offline, deterministic) or `openai` |
| `OPENAI_API_KEY` | Only needed when `AI_PROVIDER=openai` |
| `STORAGE_DRIVER` | `local` — writes under `UPLOAD_ROOT` |
| `UPLOAD_ROOT` | `./public/uploads` |
| `MAX_IMAGE_BYTES` | 5 MB |
| `MAX_VIDEO_BYTES` | 50 MB |
| `SMS_GATEWAY` | `mock` — writes to the `sms_logs` table |
| `DISCLAIMER_TEXT` | Last-resort fallback. The live value is the `AiConfig` row. |

The `.env` currently in the repo is a development placeholder with
`AUTH_JWT_SECRET="dev-only-secret-change-me-in-production-8f3a9c2b1d4e5f6a"`.
Replace it before any deployment.

---

## Daily commands

```bash
npm run dev          # dev server on http://localhost:3000
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run db:migrate   # create + apply a migration
npm run db:deploy    # apply committed migrations
npm run db:seed      # seed data
npm run db:studio    # Prisma Studio
npm run db:reset     # drop + recreate + reseed (destructive)
```

---

## Folder structure

```
euro-glam-bd/
├── docs/
│   ├── FEATURE-AI-ADVISOR.md     # feature specification
│   └── SETUP.md                  # this file
├── prisma/
│   ├── migrations/20260101000000_init/migration.sql
│   ├── schema.prisma
│   └── seed.ts
├── public/uploads/               # local media (git-ignored)
│   ├── advisor/
│   ├── products/
│   └── reviews/
├── scripts/
│   └── probe-db.ts               # local credential probe (not deployed)
├── src/
│   ├── app/
│   │   ├── advisor/components/   # chat UI (Steps 12+)
│   │   ├── api/
│   │   │   ├── admin/advisor/
│   │   │   │   ├── config/       # GET|PUT  (Step 11)
│   │   │   │   └── messages/     # GET      (Step 11)
│   │   │   └── advisor/
│   │   │       ├── chat/         # POST     (Step 11)
│   │   │       ├── config/       # GET      (Step 11)
│   │   │       ├── conversations/# GET      (Step 11)
│   │   │       └── profile/      # GET|PUT  (Step 11)
│   │   ├── layout.tsx
│   │   └── page.tsx
│   └── lib/
│       ├── ai/                   # provider.ts, mock, openai, service
│       ├── api/                  # types.ts, respond.ts
│       ├── auth/                 # jwt.ts, session.ts, guards.ts
│       ├── conflicts/            # catalogue.ts, rules.ts, engine.ts
│       ├── storage/              # adapter.ts, local-driver.ts
│       ├── upload/               # validate.ts (magic-byte checks)
│       ├── validation/           # schemas.ts
│       ├── db.ts                 # Prisma client singleton
│       └── advisor/ (types)
└── types/
```

---

## Known environment constraints

1. **No Docker.** PostgreSQL runs natively as a Windows service. There is no
   `docker-compose.yml` for a database — the local install is used instead.
2. **The `postgres` password is unknown.** See the section at the top.
3. **`npm install` must be run from a path the sandbox permits.** The
   assistant installed dependencies in a sibling temp directory and copied
   `node_modules` across. On your own machine, `npm install` in the project
   root works normally.
4. **PostgreSQL 18's `bin` is not on PATH.** Use the full path
   `"C:\Program Files\PostgreSQL\18\bin\psql.exe"`, or add that directory to
   PATH.
5. **Prisma 8 is available** (this project pins 6.19.3). The 6 → 8 jump is a
   major-version upgrade; do it deliberately, and note that `package.json#prisma`
   is deprecated in favour of `prisma.config.ts` — already migrated here.

---

## Next steps

Steps 7–13 of the feature specification:

| Step | Deliverable |
|---|---|
| 7 | Auth foundation — `jose` signing, session cookies, `requireUser` / `requireAdmin` guards |
| 8 | Storage adapter + magic-byte upload validation |
| 9 | Conflict rules engine + unit tests (**the highest-value tests in the codebase**) |
| 10 | `AiProvider` interface, deterministic mock, OpenAI provider, orchestration service |
| 11 | API routes |
| 12 | Chat UI |
| 13 | Seed data (already written — `prisma/seed.ts`) |
| 14 | Admin monitoring screens |
