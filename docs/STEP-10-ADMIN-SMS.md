# Step 10 — Admin Dashboard, Review Moderation & SMS Workflow

Implementation guide for the Euro Glam BD MVP.

This document explains **why** the code is shaped the way it is. The code
itself is the specification; this is the reasoning behind it.

Steps 1–9 built a shop with a catalogue, a cart and a transactional
checkout. Step 10 builds the other half: the surface where a human being
runs the business.

---

## 0. The shape of the whole thing

```
src/
  app/api/admin/
    reviews/route.ts            GET  the moderation queue + counts
    reviews/[id]/route.ts       GET  one review
                                PATCH moderate it
    orders/route.ts             GET  the order list + counts
    orders/[id]/route.ts        GET  one order, in full
    orders/[id]/status/route.ts PATCH the fulfilment status
    orders/[id]/payment/route.ts PATCH the payment status
    sms/trigger-reminders/route.ts POST run the sweep
    sms/resend/route.ts         POST resend one reminder
    sms/log/route.ts            GET  the message log
  lib/
    admin/audit.ts              the audit vocabulary + writer
    admin/reviews.ts            the review moderation service
    admin/orders.ts             the admin order service + transition tables
    sms/adapter.ts              the SmsGateway interface
    sms/mock-gateway.ts         the offline driver
    sms/index.ts                gateway selection
    sms/templates.ts            the message body builder
    sms/service.ts              the sweep, the resend
    validation/admin.ts         every admin Zod schema
```

The layering is the same as Step 9, and it is the same rule:

| Layer | May do | May not do |
|-------|--------|------------|
| **Route handler** | parse input, call the guard, call a service, shape a response | contain business logic |
| **Service** (`lib/admin/*`, `lib/sms/service.ts`) | business logic, database access, transaction boundaries | know about HTTP beyond `ApiError` |
| **Pure module** (`lib/sms/templates.ts`, the transition tables) | computation | touch the database, the clock, the network |

The admin order service is a **separate module** from the customer order
service (`src/lib/orders/service.ts`). They are not one service with a
flag, because they have different authorisation, different obligations
(every admin change must be audited) and different invariants (a customer
cannot move an order at all). Merging them would put an `isAdmin` branch
in the middle of the checkout path — the most safety-critical code in the
shop.

---

## 1. The admin guard

Every admin route starts with `requireAdmin()`:

```ts
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  // MUST be outside the try block.
  await connection();

  try {
    const admin = await requireAdmin();
    …
  } catch (error) {
    return handleApiError(error);
  }
}
```

`requireAdmin()` in `src/lib/auth/guards.ts` performs **two** checks, on
purpose:

1. **The token's role claim** — a cheap rejection for the overwhelmingly
   common case of a customer hitting an admin route.
2. **The role re-read from the database** — the authoritative check.

The claim in the token can be up to seven days stale, so it must never be
the sole basis for granting admin access. A demoted admin loses access
immediately, not when their token expires.

`src/proxy.ts` already rejects `/api/admin/*` before the request reaches
a handler. **The proxy is a fast filter; the guard is the authority.**
The proxy can be bypassed by a direct call to the route, so a guard that
trusted it would be a guard that trusts nothing.

### 1.1 `await connection()` sits outside the try

Every admin route reads the session cookie, so it must opt out of
prerendering. `await connection()` throws if it is called during
prerender — and that throw would be swallowed by the `catch` below if it
were inside the block, turning a build error into a mystery 500. It is
the first line of every handler, above the `try`.

### 1.2 Next 16 delivers `params` as a Promise

```ts
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();
  try {
    const { id } = await context.params;
    …
```

---

## 2. Validation — a separate vocabulary

`src/lib/validation/admin.ts` is **not** an extension of
`src/lib/validation/commerce.ts`. The commerce file is the
customer-facing vocabulary: what a shopper may send. The admin file is
the staff-facing vocabulary: what a member of staff may send.

Keeping them apart is not tidiness. Mixing them would blur the most
important boundary in the system — the difference between what a
customer can do and what an admin can do — and it would make it far
easier to accidentally reuse a permissive customer schema on an admin
route.

The rules are the same as everywhere else:

- **Invalid input is rejected, never silently ignored.** A filter the
  server does not recognise is a 400, not a default. If the client asks
  for `status=shipped` and gets `PENDING` back with a 200, nobody can
  work out why.
- **Query strings are strings.** `page=3` arrives as `"3"`, so the
  numeric fields coerce explicitly with `z.coerce.number()`.
- **Free text is bounded.** A `reason` is a sentence, not a document —
  trimmed, capped at 500 characters.

```ts
export const reviewModerationSchema = z.object({
  action: z.enum(["APPROVE", "HIDE", "UNHIDE"]),
  reason: z.string().trim().max(500).optional(),
});
```

### 2.1 The target enums are the *reachable* targets, not the whole domain

```ts
export const orderStatusTargetSchema = z.enum([
  "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED",
]);
```

`PENDING` is absent. An order is created as `PENDING` and an admin never
moves an order *back* to it — the transition table is forward-only. The
same reasoning removes `PENDING` from the payment target enum: the money
has not moved yet, and marking an order `PAID` before the courier
collects the cash would be recording something untrue.

**The validation layer refuses what the state machine would refuse
anyway.** The enum is the first gate; the transition table is the
second. Both must agree, and both are tested.

---

## 3. The audit log

### 3.1 One general table

`AdminAuditLog` is one table with an `entityType` column, not per-entity
columns like `approvedBy` / `hiddenBy` / `approvedAt`.

The deciding argument: a review can be approved → hidden → re-approved.
Per-entity columns would **destroy** the earlier decisions. The history
of those decisions must survive, so the history *is* the table.

```prisma
model AdminAuditLog {
  id String @id @default(cuid())

  actorId    String?
  actor      User?   @relation(fields: [actorId], references: [id], onDelete: SetNull)
  actorName  String  @db.VarChar(160)
  actorEmail String  @db.VarChar(255)

  action     AdminAction
  entityType String   @db.VarChar(40)
  entityId   String   @db.VarChar(64)

  before Json? @db.JsonB
  after  Json? @db.JsonB

  reason String? @db.VarChar(500)
  createdAt DateTime @default(now())
}
```

Three details worth stating:

- **`actorId` is `SetNull`, and the name and email are copied onto the
  row.** When an admin's account is deleted, the trail outlives it — and
  the entry still names a human rather than pointing at nothing.
- **`before` / `after` are `Jsonb`, not `Json`.** A plain `Json` column
  cannot be compared in `.where()` at all, and an audit trail you cannot
  filter is a log file.
- **They carry only status flags and order statuses.** Never an
  address, never a price. An audit log is a privileged view; it should
  not become a second copy of the customer table.

### 3.2 The audit entry and the mutation share one transaction

This is the rule that governs the whole step:

```ts
await db.$transaction(
  async (tx: Prisma.TransactionClient) => {
    const updated = await tx.review.updateMany({ … });
    if (updated.count === 0) throw ApiError.conflict(…);

    await writeAuditEntry(tx, { actor, action, entityType, entityId, before, after, reason });

    return tx.review.findUnique({ … });
  },
  { maxWait: 5_000, timeout: 10_000 },
);
```

**A mutation without an audit trail is worse than no audit trail at all,
because it looks complete.** If the two writes were separate, a crash
between them leaves a cancelled order with no record of who cancelled
it — and a support agent asking "who did this and why" gets silence.

The rule is enforced by the **type**, not by a convention:

```ts
export async function writeAuditEntry(
  tx: AuditTransactionClient,   // Prisma.TransactionClient
  entry: AuditEntryInput,
): Promise<void>
```

There is deliberately **no overload that accepts the root `db` client**.
`Prisma.TransactionClient` omits `$transaction` and `$connect`, so
writing an audit entry outside a transaction is awkward *by construction*
rather than by documentation. A future engineer cannot "just" call it
with `db` — the type system says no.

### 3.3 The action vocabulary is closed

`AdminAction` is a Prisma enum:

```
REVIEW_APPROVED           REVIEW_HIDDEN              REVIEW_UNHIDDEN
ORDER_STATUS_CHANGED      ORDER_PAYMENT_STATUS_CHANGED  ORDER_CANCELLED
SMS_REMINDER_SWEEP        SMS_REMINDER_SENT          SMS_REMINDER_RESENT
```

It is an enum because it is a genuinely closed set, and the schema
already has enums for every domain-wide finite set (`UserRole`,
`OrderStatus`, `PaymentStatus`). `SmsLog.status` is the precedent for
an *open* set that varies by driver — an audit action is not open.

The lookup objects (`REVIEW_ACTIONS`, `ORDER_ACTIONS`, `SMS_ACTIONS`)
keep a moderation action and its audit entry from drifting apart: the
same string is used for both.

---

## 4. Review moderation

### 4.1 The state machine

Three states, derived from two flags:

| `isApproved` | `isHidden` | State | Public? |
|-------------|-----------|-------|---------|
| false | false | `PENDING` | No — awaiting moderation |
| true | false | `APPROVED` | Yes |
| true | true | `HIDDEN` | No — was approved, now withdrawn |

```
PENDING  → APPROVED   (approve)
APPROVED → HIDDEN     (hide)
HIDDEN   → APPROVED   (unhide)
```

**Hiding a pending review is refused.** There is nothing to withdraw —
it was never published — and silently setting `isHidden` on it would
produce a fourth, unreachable combination (`isApproved = false,
isHidden = true`) that no queue would ever show.

### 4.2 Why the public predicate needs both flags

```ts
export function isPublicReview(review: {
  isApproved: boolean;
  isHidden: boolean;
}): boolean {
  return review.isApproved && !review.isHidden;
}
```

`isApproved` alone is not enough. Hiding sets `isHidden = true` and
**leaves `isApproved = true`** — because the review *was* approved, and
that history must not be lost. A public review query that checked only
`isApproved` would publish hidden reviews.

This is the reason the row carries two flags rather than a single
`status` enum: `isApproved` records the decision, `isHidden` records the
current visibility, and the two answer different questions. The *who*
and the *why* live in the audit log; the row carries only the current
state.

### 4.3 The conditional update

```ts
const updated = await tx.review.updateMany({
  where: {
    id: reviewId,
    isApproved: current.isApproved,   // the state the read observed
    isHidden: current.isHidden,
  },
  data: { isApproved: target.isApproved, isHidden: target.isHidden, moderatedAt: new Date() },
});

if (updated.count === 0) {
  throw ApiError.conflict(
    "That review was moderated by someone else. Reload and try again.",
  );
}
```

Two admins moderating the same review at the same time race here, and
**exactly one wins**. The loser's `updateMany` matches zero rows and
gets a 409 rather than silently overwriting the winner's decision.

The obvious alternative is wrong:

```ts
const review = await tx.review.findUnique({ where: { id } });
review.isApproved = true;                       // ← RACE
await tx.review.update({ where: { id }, data: review });
```

Between the read and the write, another transaction can commit. The
read-then-write form has no way to notice that the world moved.

### 4.4 The counts come from the same `where` shapes

```ts
export function reviewStateWhere(state: ReviewStatusFilter): Prisma.ReviewWhereInput {
  switch (state) {
    case "PENDING":  return { isApproved: false, isHidden: false };
    case "APPROVED": return { isApproved: true,  isHidden: false };
    case "HIDDEN":   return { isApproved: true,  isHidden: true };
    case "ALL":      return {};
  }
}
```

The list, the `total`, and the three per-state counts all use
`reviewStateWhere`. A filter that matched the list but not the count
would show "12 results" above a list of 0 — and an admin would spend
twenty minutes looking for reviews that are not there.

### 4.5 Routes

```
GET   /api/admin/reviews
      ?status=PENDING|APPROVED|HIDDEN|ALL   (default PENDING)
      ?productId=&userId=&page=&limit=
      → { reviews, pagination, counts: { pending, approved, hidden, all } }

GET   /api/admin/reviews/[id]
      → { review }

PATCH /api/admin/reviews/[id]
      body: { action: "APPROVE" | "HIDE" | "UNHIDE", reason?: string }
      → { review }
```

---

## 5. Admin order management

### 5.1 The transition table

Fulfilment moves **forward only**:

```
PENDING    → PROCESSING, CANCELLED
PROCESSING → SHIPPED, CANCELLED
SHIPPED    → DELIVERED
DELIVERED  → (terminal)
CANCELLED  → (terminal)
```

**`SHIPPED → CANCELLED` is deliberately absent.** The goods have left
the warehouse; a cancellation would be a lie, and the refund is a
separate operation with its own audit trail.

Payment moves **independently**:

```
PENDING → PAID | FAILED | REFUNDED
PAID    → REFUNDED
FAILED  → (terminal)
REFUNDED→ (terminal)
```

A COD order can be `SHIPPED` while the payment is still `PENDING`,
because the cash is collected on delivery. **The two axes have separate
audit actions for exactly this reason** — `ORDER_STATUS_CHANGED` and
`ORDER_PAYMENT_STATUS_CHANGED` are different facts, and conflating them
would make the audit trail ambiguous.

### 5.2 Cancelling restores the stock

```ts
if (target === OrderStatus.CANCELLED) {
  for (const item of order.items) {
    await tx.product.update({
      where: { id: item.productId },
      data: { stockQuantity: { increment: item.quantity } },
    });
  }
}
```

Two things make this correct:

1. **Every permitted cancellation is pre-dispatch.** `CANCELLABLE_FROM`
   is `PENDING` and `PROCESSING` only. The `SHIPPED → CANCELLED` edge is
   absent, so the goods are always still on the shelf when they go back.
   The rule and the transition table cannot drift apart, because
   `CANCELLABLE_FROM` is *derived* from the table rather than written
   out separately.

2. **The quantity restored is the snapshotted one** — `item.quantity`
   from the order line, never a re-derived number. The arithmetic is
   exact: `stock_after_checkout + quantity = stock_before_checkout`.

The restoration is in the **same transaction** as the status change. An
order cannot be cancelled without the stock coming back, and the stock
cannot come back without the order being cancelled.

### 5.3 Cancelling twice restores the stock once

Because the status update is conditional on the *current* status:

```ts
const updated = await tx.order.updateMany({
  where: { id: orderId, status: order.status },
  data: { status: target },
});

if (updated.count === 0) {
  throw ApiError.conflict("That order was changed by someone else. Reload and try again.");
}
```

Two admins cancelling the same order race here. The winner's
`updateMany` matches one row and proceeds to the increments. The loser's
matches zero rows and the transaction rolls back **before any increment
runs**. The stock is restored exactly once.

This is a regression test, not a claim: *"cancelling twice restores the
stock exactly once"*.

### 5.4 The three ways an admin route can say "no"

An illegal action must be refused **and explained**. A 409 that says
only "conflict" is a support ticket; a 409 that names the current state
and what would have been allowed is a fix.

| Situation | Status | Body |
|---|---|---|
| The review is not in a state the action applies to | 409 | The current state and the action |
| Another admin moderated the same review first | 409 | "moderated by someone else. Reload and try again." |
| The order cannot move to the requested status | 409 | `currentStatus`, `requestedStatus`, `permittedStatuses` |

In all three cases **nothing is written** — no status change and no
audit entry. A refused action leaves no trace in the audit log, because
the audit log records decisions, not attempts.

`ApiError.conflict` takes an optional `details` argument for this:

```ts
static conflict(message: string, details?: Record<string, unknown>): ApiError
```

### 5.5 Routes

```
GET   /api/admin/orders
      ?status=&paymentStatus=&userId=&search=&page=&limit=
      → { orders, pagination, counts: { byStatus, byPaymentStatus, total } }

GET   /api/admin/orders/[id]
      → { order }

PATCH /api/admin/orders/[id]/status
      body: { status: "PROCESSING"|"SHIPPED"|"DELIVERED"|"CANCELLED", reason? }
      → { order }

PATCH /api/admin/orders/[id]/payment
      body: { paymentStatus: "PAID"|"FAILED"|"REFUNDED", reason? }
      → { order }
```

The order counts are computed over the **whole** order table, not the
filtered page, so an admin can see "14 pending" and navigate to them
even while looking at a filtered list.

---

## 6. The SMS workflow

### 6.1 The gateway abstraction

`src/lib/sms/adapter.ts` mirrors `src/lib/ai/index.ts` (selection) and
`src/lib/storage/adapter.ts` (interface).

```ts
export interface SmsGateway {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

export type SmsMessage = {
  readonly to: string;
  readonly body: string;
  readonly idempotencyKey: string;
};
```

The interface is deliberately narrow — one operation. No delivery-status
callback, no scheduling, no bulk send. The MVP does not need them, and a
wide interface is harder to implement for every future driver.

**The idempotency key travels with the message.** `SmsLog.idempotencyKey`
is `@unique`, and the key is derived from the order item id, so a re-run
of the sweep cannot double-send. The key is part of the message rather
than something the gateway computes, because the key that protects
against a double-send has to be the *same* key the database enforces.

> The column is `String?` — nullable, because the table predates the
> workflow and a legacy row has no key. **The nullability does not
> weaken the guarantee**, because every key this workflow writes is
> non-null, and PostgreSQL treats `NULL != NULL` — so the uniqueness
> constraint only ever applies to the keys that exist. A `null` row
> cannot be "claimed" by a second sweep, but the sweep's own rows always
> carry a key. See `DECISIONS.md` §"Nullable `@@unique` does not enforce
> 'one active row'".

### 6.2 Gateway selection

```ts
export function getSmsGatewayName(): SmsGatewayName {
  const raw = process.env.SMS_GATEWAY?.trim().toLowerCase();
  if (!raw || raw === "mock") return "mock";
  if (raw === "sslwireless") return "sslwireless";
  console.warn(`[sms] Unrecognised SMS_GATEWAY="${raw}". Falling back to "${DEFAULT_SMS_GATEWAY}".`);
  return DEFAULT_SMS_GATEWAY;
}
```

**The deliberate asymmetry:**

- An unrecognised `SMS_GATEWAY` **warns and falls back to mock**. A typo
  in a deployment variable should degrade to a working offline gateway,
  not take the storefront down — and it logs loudly so the typo is
  noticed.
- A **missing credential throws**. A deployment that would message real
  customers must not silently deliver nothing while looking healthy.

This mirrors `getAiProvider()` exactly.

### 6.3 The message body

`src/lib/sms/templates.ts` is pure and deterministic — no clock, no
randomness, no network.

```
Your Euro Glam Bd order EGB-20261027-A1B2C3 includes Niacinamide 10%
Serum, which you estimated will run out soon. Time to reorder?
https://euroglambd.com/orders/EGB-20261027-A1B2C3
```

Two rules:

**No shipping address.** An SMS is forwarded. It is read by whoever the
customer forwards it to, and it sits in a phone's notification list
where anyone glancing at the screen can read it. The body carries the
**product name** and the **order number** — enough to identify the
order, and nothing more.

**No "Reply STOP to opt out" line.** Not yet, and not until the platform
can actually honour a STOP. An opt-out instruction that does nothing is
a promise the system cannot keep, and it is worse than no instruction
at all: a customer who replies STOP has been told their objection was
received, and then nothing happens. Consent is enforced server-side
through `User.smsOptIn` in the meantime, which is what actually protects
the customer. When the opt-out endpoint is built, this template gains the
line and the promise becomes true.

### 6.4 Consent — one flag, asserted in the claim

**`User.smsOptIn` is the ONLY flag that authorises a send.**
`UserSkinProfile.smsOptIn` is a different feature's flag and is **not
consulted**.

The reasoning, which must survive: both flags default to `false`, and
**a default is not a decision**. Reading `UserSkinProfile.smsOptIn`'s
default as an explicit refusal means a customer who opted in at
registration and later created a skin profile would **silently stop
receiving reminders** — not because they refused, but because a feature
they used has an unrelated checkbox that was never asked. The change
looks like a security improvement and is actually a bug.

The consent is asserted **inside the claim query's `WHERE` clause**, not
checked in application code afterwards:

```ts
const claimed = await tx.orderItem.updateMany({
  where: {
    id: itemId,
    reminderSentAt: null,
    estimatedEmptyAt: { not: null, lte: dueBy },
    order: {
      user: {
        smsOptIn: true,
        phone: { not: null },
      },
    },
  },
  data: { reminderSentAt: now },
});
```

A customer who opts out **mid-sweep** is still protected: the claim
fails, and nothing is sent. A check that happens after the fetch has a
window in which the customer can opt out — and a window is exactly where
a consent bug lives.

The candidate list is filtered on the reminder *window* only, not on
consent, so the sweep can report **how many items it skipped because the
customer had not opted in**. That count is the evidence that consent is
working.

### 6.5 What "due" means

An item is due when **all** hold:

- `estimatedEmptyAt` is not null — **estimates are never inferred**.
- `estimatedEmptyAt <= now + 3 days` — a fixed lead time, so the
  reminder arrives *before* the product runs out.
- `reminderSentAt` is null.
- The owning user has `smsOptIn = true` **and** a phone number.

**The lead time is a constant, not a setting:**

```ts
export const REMINDER_LEAD_TIME_DAYS = 3;
```

A setting defaulting to zero would mean "due exactly now", and a sweep
run at the wrong moment would silently do nothing — which looks
identical to "there is nothing to remind about". That is the Step 9 bug
class, and a constant cannot be misconfigured.

### 6.6 The gateway call sits BETWEEN two transactions

```ts
// 1. Claim the item (sets reminderSentAt) and read what to send.
const claimed = await db.$transaction(async (tx) => { … });

// 2. Send — no transaction open, so no pooled connection is held for
//    the provider's latency.
const result = await gateway.send({ to, body, idempotencyKey });

// 3. Record the outcome.
await recordSend({ … });
```

One transaction around all three would hold a database connection open
across a network call, and on a busy shop that exhausts the pool.

The ordering is **claim → send → log**, deliberately. **A missing log
row is a reporting gap, and it is recoverable. A double-send is not.**

### 6.7 One failure does not abort the rest

A provider outage on item 3 must not prevent items 4 through 100 from
being reminded. The sweep catches the failure per item, records it with
an error code, and continues.

A failed send is recorded with `status: "failed"` and the error code,
and `reminderSentAt` **stays set** — so the automated sweep does not
loop on it — and the admin can resend manually.

### 6.8 Idempotency

The key is deterministic:

```ts
export function reminderIdempotencyKey(orderItemId: string): string {
  return `reminder:${orderItemId}`;
}

export function manualResendIdempotencyKey(orderItemId: string): string {
  return `reminder:${orderItemId}:manual`;
}
```

The manual resend uses a **distinct** key. If it were the same, the
admin's explicit instruction to resend would be silently swallowed by
the unique constraint from the original automated message — the admin
would see a success response and the customer would receive nothing.

### 6.9 The manual resend claims the key BEFORE sending

This was a real bug, found by the integration tests.

The original code asked "does a log row with this key exist?" and,
finding none, sent the message. Two admins clicking "resend" at the same
moment would both pass the check and both send. Worse, the failure path
*inserted* a second row with the same key, so the unique-constraint
violation masked the real error.

The fix is to make the **unique constraint** the arbiter, and it only
works if the row is written first:

```ts
// A fast pre-check — NOT the guarantee.
const existing = await db.smsLog.findUnique({
  where: { idempotencyKey: input.idempotencyKey },
  select: { id: true },
});
if (existing) return false;

try {
  await db.smsLog.create({ data: { …, status: "queued" } });
  return true;
} catch (error) {
  if (error.code === "P2002") return false;   // lost the insert race
  throw error;
}
```

The pre-check keeps a normal, handled refusal out of the database error
log. The `P2002` catch is what actually handles the race. The failure
path now **updates** the claimed row rather than inserting a second one.

### 6.10 A manual resend does NOT bypass consent

It **bypasses the schedule** — the item may already have been reminded,
and the reminder may not be due yet. That is the point of a manual
resend.

It does **not** bypass consent. Admin authority is for *deciding to
send*, not for *overriding the recipient's consent*. A customer who has
not opted in cannot be messaged, even by an admin, and the request is
refused with a 409 saying so.

### 6.11 The sweep reports four separate numbers

```ts
export type ReminderSweepResult = {
  readonly examined: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly details: ReminderOutcome[];
  readonly truncated: boolean;
};
```

A run that examined 40 items and sent 0 is visibly different from a run
that examined 0. Without that distinction, "nothing was sent" is
indistinguishable from "nothing needed sending" — which is the Step 9
"silently empty" bug class.

`details` carries a **precise** reason per item. The original code used
one string for four different causes — "not claimed: already reminded,
no longer due, or the customer has not opted in" — which is true in all
four cases and useful in none. An admin reading the report cannot tell a
consent outcome from a no-op. The claim now reports *why* it failed:

```ts
type ClaimFailure =
  | "already_reminded" | "no_longer_due" | "no_consent" | "no_phone" | "not_found";
```

### 6.12 Routes

```
POST /api/admin/sms/trigger-reminders
      body: { dryRun?: boolean }   (default false)
      → { examined, sent, skipped, failed, details, truncated }

POST /api/admin/sms/resend
      body: { orderItemId: string, reason?: string }
      → { sent: true, smsLogId, phone }

GET  /api/admin/sms/log
      ?userId=&status=&orderItemId=&page=&limit=
      → { logs, pagination, counts: { sent, failed, total } }
```

A **dry run** reports what the sweep *would* do without sending anything
and without changing a single row — including the consent check, so the
admin can see exactly who would be messaged and who would be skipped.

---

## 7. Error handling

Every admin route ends with the same block:

```ts
} catch (error) {
  return handleApiError(error);
}
```

`handleApiError` in `src/lib/api/errors.ts` is the single error path for
the whole API:

| Thrown | Response |
|---|---|
| `ApiError` | Its own status and code, plus `details` |
| `ZodError` | 400 `VALIDATION_ERROR` with `details.fieldErrors` |
| Prisma `P2002` | 409 `CONFLICT` — "That record already exists." |
| Prisma `P2025` | 404 `NOT_FOUND` |
| Prisma `P2034` | 409 `CONFLICT` — a transaction conflict; the caller may retry |
| Anything else | 500 `INTERNAL_ERROR`, logged server-side, **never** the raw message |

The last row is the important one: the underlying message is logged
server-side but never returned to the client, so stack traces and
database errors cannot leak to callers.

The `ApiError` codes used across this step:

| Code | Status | Used for |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Signed in, but not an admin |
| `NOT_FOUND` | 404 | No such review, order or order item |
| `VALIDATION_ERROR` | 400 | The body or query failed the schema |
| `CONFLICT` | 409 | An illegal transition, a lost race, no consent |
| `SERVICE_UNAVAILABLE` | 503 | The SMS provider failed |
| `INTERNAL_ERROR` | 500 | Anything unrecognised |

---

## 8. The schema changes

```prisma
enum AdminAction {
  REVIEW_APPROVED
  REVIEW_HIDDEN
  REVIEW_UNHIDDEN
  ORDER_STATUS_CHANGED
  ORDER_PAYMENT_STATUS_CHANGED
  ORDER_CANCELLED
  SMS_REMINDER_SWEEP
  SMS_REMINDER_SENT
  SMS_REMINDER_RESENT
}
```

`Review` gains:

```prisma
  isApproved Boolean  @default(false)
  isHidden   Boolean  @default(false)
  moderatedAt DateTime?

  @@index([isApproved, isHidden])
```

`SmsLog` gains `status`, `provider`, `errorCode`, `orderItemId`,
`reason` and `providerMessageId`, plus indexes on `createdAt` and
`status` — the admin log view sorts by the first and filters by the
second, and neither was indexed.

`OrderItem` gains `@@index([reminderSentAt])` — the sweep filters on
`estimatedEmptyAt` **and** `reminderSentAt IS NULL`, and the second had
no index.

**`providerMessageId` was missing from the schema.** The service passed
it to the log writer and Prisma silently dropped it — the field was not
in the schema, so the write omitted it. The provider's own reference is
exactly what support needs in order to ask the provider what happened to
a specific message.

The migration is
`prisma/migrations/20261027120000_admin_audit_and_sms_workflow/migration.sql`.

---

## 9. Tests

| Suite | Needs a DB | Proves |
|---|---|---|
| `tests/admin/review-moderation.test.ts` | No | The state machine; the public predicate needs both flags; hiding a pending review is refused |
| `tests/admin/order-transitions.test.ts` | No | Forward-only; `SHIPPED → CANCELLED` absent; terminal states; the two axes independent |
| `tests/admin/audit.test.ts` | No | The action vocabulary is closed; the entry shape |
| `tests/sms/gateway.test.ts` | No | Selection rules and the asymmetric fallback; the mock's idempotency |
| `tests/sms/templates.test.ts` | No | No address, no phone, no STOP line; deterministic |
| `tests/sms/idempotency.test.ts` | No | Deterministic keys; manual ≠ automated |
| `tests/validation/admin.test.ts` | No | Coercion, bounds, rejected filters, the reason cap |
| `tests/integration/admin-reviews.test.ts` | Yes | Moderation + audit in one transaction; concurrent moderation → one 409; the counts match the queues |
| `tests/integration/admin-orders.test.ts` | Yes | A legal transition writes both; an illegal one writes neither; **cancelling restores the stock**; **cancelling twice restores it once** |
| `tests/integration/sms-reminders.test.ts` | Yes | A reminder is sent when due; **not** sent without opt-in; not sent without a phone; the lead time; **sweep twice = one message**; concurrent sweeps = one message; a failure is recorded and the sweep continues; a manual resend **still requires consent** |

**The gateway is injected** — `triggerDepletionReminders(actor, { gateway:
new MockSmsGateway() })` — so the tests never touch the environment.
That is why `getSmsGateway()` is a **default parameter**, not a hard
dependency. A `FailingSmsGateway` double injects failures.

The integration suites follow the Step 9 pattern: a `databaseAvailable`
flag resolved in `beforeAll` via `prisma.$queryRaw\`SELECT 1\``, early
returns when the database is unreachable, and `afterAll` cleanup in
dependency order.

### 9.1 Running the gate

```bash
npx tsc --noEmit
npx eslint .
npx vitest run
npx next build

# The readable reports
npm run verify:step9
npm run verify:step10
```

The Step 9 verification script must still pass. Step 10 must not regress
it.

---

## 10. The environment variables

```
SMS_GATEWAY="mock"
SSL_WIRELESS_API_KEY=""        # required when SMS_GATEWAY="sslwireless"
NEXT_PUBLIC_SITE_URL="https://euroglambd.com"
```

The default is `mock`: no credentials, no network, and no messages
leaving the machine. The whole workflow — the consent gate, the
idempotency claim, the log write, the failure path — is exercised
offline. Only the last hop is replaced.

---

## 11. The bugs found while building this

These were found by the Step 10 integration and verification work, not by
inspection. Each is now covered by a regression test.

**1. The manual resend's idempotency was a check-then-act.** Two admins
clicking "resend" at the same moment both passed the pre-check and both
sent — and the failure path inserted a second row, so the unique
constraint masked the real error. *Fixed* by claiming the key with an
insert before the provider is called, and by updating the claimed row on
failure. *Guard:* "refuses a repeated manual resend of the same item" and
"the refused resend sent nothing".

**2. `SmsLog` had no `providerMessageId` column.** The service passed it
to the log writer and Prisma silently dropped it. *Fixed* by adding the
column to the schema and to the migration. *Guard:* the manual-resend
path asserts on the reference being written.

**3. The sweep's skip reason was one string for four different causes.**
True in all four cases and useful in none. *Fixed* by making the claim
report *why* it failed, with a precise reason per item. *Guard:* the
skip reason is asserted for the no-consent and no-phone cases.

---

## 12. The rules that carry forward

1. **An audit entry is written in the same transaction as the change it
   describes.** A mutation without an audit trail is worse than no audit
   trail, because it looks complete.
2. **The proxy is a fast filter; the guard is the authority.** The guard
   re-reads the role from the database.
3. **A conditional `updateMany` is how two admins are made to agree.** The
   loser gets a 409, and nothing is written.
4. **Consent is asserted in the query, not checked afterwards.**
5. **The key that prevents a double-send must be the key the database
   enforces.**
6. **A missing log row is recoverable. A double-send is not.** Hence
   claim → send → log.
7. **A refusal must explain itself.** Name the current state and what
   would have been allowed.
8. **Report the numbers separately.** `examined` / `sent` / `skipped` /
   `failed`; `pending` / `approved` / `hidden`. A single total hides the
   bug class this whole step is built to avoid.
9. **A default is not a decision.** `User.smsOptIn` is the only consent
   flag.
10. **A promise the system cannot keep is a bug.** No "Reply STOP"
    until it can honour one.
