# Architecture Decisions — Euro Glam BD MVP

All 12 decisions locked and approved. This file is the source of truth; code must conform to it.

| # | Area | Decision |
|---|------|----------|
| 1 | Deliverable | Working MVP with mocked external services (real DB, real business logic, adapters for AI/SMS/Storage) |
| 2 | Database & ORM | PostgreSQL + Prisma ORM |
| 3 | Backend routing | Next.js App Router — route handlers at `src/app/api/**/route.ts` |
| 4 | Checkout | Cash-on-Delivery (COD); `payment_method` / `payment_status` columns present from day one |
| 5 | Auth | Custom JWT via `jose`; HTTP-only cookie; `SameSite=Lax`; 7-day TTL; server-side `CUSTOMER` / `ADMIN` role checks |
| 6 | AI execution | `AiProvider` interface; deterministic mock by default; real OpenAI behind `AI_PROVIDER=mock\|openai` |
| 7 | Conflict engine | Pure deterministic TypeScript rules engine; severities `BLOCK` and `WARN` |
| 8 | Media storage | `StorageAdapter` abstraction; local filesystem driver; robust server-side upload validation |
| 9 | SMS workflow | Scheduled reminder processing via mock `SmsGateway`; persistent `SmsLog`; explicit opt-in consent; admin-triggered run-now |
| 10 | Review moderation | Unverified purchases allowed; `isApproved=false` default; hidden publicly until admin approval |
| 11 | Deployment | Long-running Node.js server environment (not serverless — local disk storage requires a persistent filesystem) |

## Derived engineering rules

- **Referential actions are explicit.** Prisma's default is `SetNull` for optional relations and `Restrict` for mandatory ones. Every relation whose history must survive is written with an explicit `onDelete: Restrict`. `relationMode` stays at the default `foreignKeys` — `prisma` mode moves enforcement into the client and is *weaker*, not stronger.
- **Money is `Int` in the smallest unit (poisha), never `Float`.** BDT has 2 decimal places (1 BDT = 100 poisha). `Float` is excluded because binary floating point cannot represent decimal amounts exactly and sums drift. `Decimal` is reserved for values needing more precision than the currency has.
- **Use `Jsonb`, not `Json`,** for filterable JSON columns — a plain `Json` column cannot be compared in `.where()` at all.
- **`String[]` scalar lists are PostgreSQL-only and must not be indexed.** `@@index` on a scalar list is undocumented/unsupported — use a raw GIN index via `addColumn`/raw SQL if containment lookups are needed later.
- **Nullable `@@unique` does not enforce "one active row".** PostgreSQL treats `NULL != NULL`, so multiple NULLs are allowed. Use a non-null discriminator column or a partial unique index.
- **The LLM never decides whether a conflict exists.** The rules engine is pure, deterministic, and I/O-free; the LLM only phrases an already-decided result.
- **Depletion estimates are user-provided**, never inferred from order data — inference would be fabricated precision.
- **SMS requires explicit opt-in** (`smsOptIn`, default `false`).
