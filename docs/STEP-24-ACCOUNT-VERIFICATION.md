# Step 24 — Account Verification & the Dual-Purpose Code

Implementation guide for the Euro Glam BD MVP.

This document explains **why** the code is shaped the way it is. The code
itself is the specification; this is the reasoning behind it.

Step 23 built the one-time password. This step gives it a **second job** —
proving that a new account owns its inbox — and makes that proof
**mandatory** before the account can be used.

---

## 0. The shape of the whole thing

```
src/
  app/api/
    auth/register/route.ts     POST  create the account, mail a SIGNUP code
    auth/login/route.ts        POST  password sign-in, gated on verification
    auth/send-otp/route.ts     POST  issue a code (SIGNUP or SIGNIN) and mail it
    auth/verify-otp/route.ts   POST  validate the code, set the session
  components/
    commerce/
      auth-form.tsx                    the form; it grows a verification step
      register-verification-form.tsx   the registration verification step
      otp-code-field.tsx               the shared six-digit input
      otp-sign-in-form.tsx             the passwordless sign-in form
  lib/
    auth/otp.ts                issue / verify, the rules
    auth/verification.ts       the signup verification service
    auth/session.ts            the session cookie
    validation/otp.ts          the schemas and the limits
prisma/
  schema.prisma                User.emailVerifiedAt, EmailOtp.purpose
  migrations/…_email_otp_purposes/
```

---

## 1. The rule that governs the whole feature

**Registration does not sign you in. Verification does.**

Registration proves almost nothing. It proves the person typing can reach
an inbox — but only if they can read the mail that is about to arrive. A
mistyped address, an address belonging to somebody else, an address
harvested from a forum: each produces an account that receives the
customer's order confirmations, their SMS alerts and their one-time
passwords, and none of them is the customer.

Issuing a session at registration would make the shop believe it can reach
the customer when it cannot. The verification step is where that belief is
earned.

So:

- the account is created with `emailVerifiedAt: null`;
- a six-digit code is mailed to the address;
- **no session cookie is written**;
- the response says the account is waiting for that code.

---

## 2. Why the account state is a timestamp

```prisma
emailVerifiedAt DateTime?
```

`null` means "not yet verified". A `Boolean verified` cannot tell "never
asked" from "said no" — and for a shop deciding whether it may send a
one-time password to an address, the difference between *nobody has
proved this* and *somebody asked and failed* is worth keeping.

The timestamp also answers "when did we verify this?", which a boolean
throws away.

---

## 3. Why the purpose is stored on the row

```prisma
enum OtpPurpose {
  SIGNUP
  SIGNIN
}
```

**A signup code is otherwise a valid sign-in code.** The verification
lookup reads the row for the address, and the code hashes to the same value
regardless of why it was issued — so an intercepted signup verification mail
would hand the attacker an account permanently.

The difference is load-bearing, so it is in the data. `purpose` is a column,
the lookup is scoped by it, and the row for the other purpose is **not
merely rejected — it is not even read**. There is nothing to compare the
submitted digits against.

```ts
const record = await db.emailOtp.findFirst({
  where: { email, purpose },   // ← the scope is the whole defence
  orderBy: { createdAt: "desc" },
  // …
});
```

### The two purposes have different preconditions

| Purpose | Issued for | Refused when |
|---------|-----------|--------------|
| `SIGNUP` | An account that has not been verified | The account is **already** verified — it has nothing left to prove |
| `SIGNIN` | An account that exists and is usable | The account has **not** been verified — a sign-in code would be a code for a door that is not open yet |

Both refusals are reported as `sent: false, knownAddress: true` — the
address *is* known; the request just cannot be honoured for it. The caller
chooses the words, because "this account is already verified" and "this
account still needs verifying" need different messages.

### The deletion is scoped too

```ts
await db.emailOtp.deleteMany({ where: { email, purpose } });
```

Asking for a sign-in code must not silently destroy a pending signup code,
and vice versa. The two flows are separate journeys, and a customer may be
in the middle of one while the other runs.

---

## 4. The verification gate

The gate is a check on `emailVerifiedAt === null`, and it lives in the two
routes that **issue a session**:

- `POST /api/auth/login` — after the password check.
- `POST /api/auth/verify-otp` — after the credential check.

Not in `requireUser`, and not in the edge proxy. A session is only ever
minted after the check, so a session that was never issued cannot be used,
and every authenticated request does not pay for a database round-trip to
re-ask a question that was answered when the session was created.

### Why the refusal comes after the password check

It is tidier the other way round: check the account's state first, and skip
the expensive hash. But tidier here means an **enumeration oracle**. An
attacker who does not know the password would learn which addresses are
merely awaiting verification — a fact about the account's state, obtained
without proving anything.

So the order is: password first, then the gate.

```ts
if (!user || !passwordMatches) {
  throw ApiError.unauthenticated("Incorrect email or password.");
}

// Only now — the customer has already proved they know the password.
if (user.emailVerifiedAt === null) {
  throw ApiError.forbidden("Please verify your email address before signing in. …");
}
```

A wrong password on an unverified account answers `401` with the same
message as a wrong password on a verified one. The `403` is only ever seen
by somebody who has already proved they know the password, so there is no
enumeration left to protect.

---

## 5. The signup verification service

`src/lib/auth/verification.ts` answers a question `verifyOtp` does not:

> Is this code correct **and** is it the code that verifies this account?

The second half matters. A signup code that is correct but belongs to an
account that is *already* verified would otherwise be a way to re-verify an
account — which sounds harmless, but it would also issue a session to
whoever presented the code, and the code may have been intercepted weeks
ago.

### The conditional write

```ts
const updated = await db.user.updateMany({
  where: { id: user.id, emailVerifiedAt: null },
  data: { emailVerifiedAt: new Date() },
});

if (updated.count === 0) {
  // Somebody else verified it between the read and the write.
  return { ok: true, userId: user.id, firstVerification: false };
}

return { ok: true, userId: user.id, firstVerification: true };
```

`emailVerifiedAt: null` in the `where` clause means "only if it is still
null". Two concurrent requests carrying the same valid code would otherwise
both find the account unverified and both write a timestamp. The conditional
update makes exactly one of them the writer.

It is the same shape as the conditional delete that marks a code as used,
and for the same reason: the credential is single-use, and the database is
the only place that can enforce that under concurrency.

### `firstVerification`

The answer distinguishes "you just verified this account" from "this
account was already verified". The client uses it to welcome a new customer
rather than signing them in as a returning one.

---

## 6. The client

### The registration form grows a step

`auth-form.tsx` holds a `pendingVerification` state. When registration
succeeds it does **not** navigate — it swaps the form for
`RegisterVerificationForm`, which asks for the six digits and then signs
the customer in.

The address is **captured when the registration is submitted**, not re-read
from the input. By the time the code box is showing, the email field no
longer exists.

### The code is never echoed back

A code that has been typed and rejected is cleared, so the credential is not
left in the DOM. The same rule the password form follows.

### The destination rule is unchanged

`destinationAfterSignIn(role, next)` — an admin lands in `/admin`, a
customer lands at the sanitised `next`. The same helper serves all three
sign-in paths, so the rule cannot drift between them.

### The shared code field

`otp-code-field.tsx` is one component used by both flows:
`inputMode="numeric"`, `pattern="[0-9]{6}"`, `maxLength={6}`,
`autoComplete="one-time-code"`, with `aria-invalid` and `aria-describedby`
wired to the error.

---

## 7. The mail names the purpose

A customer who just registered has a verification code in their inbox; a
customer who is signing in has a sign-in code. They look identical and mean
different things, and a customer who cannot tell them apart will type the
wrong one and conclude the shop is broken.

| | Subject | Opening line |
|---|---------|--------------|
| `SIGNUP` | `Your Euro Glam BD verification code: 123456` | "Welcome to Euro Glam BD." |
| `SIGNIN` | `Your Euro Glam BD sign-in code: 123456` | "Your Euro Glam BD sign-in code is…" |

The "if this was not you" line differs accordingly, because an unwanted
signup verification means somebody registered with their address, and an
unwanted sign-in code means somebody is trying to get in.

---

## 8. The cooldown stays purpose-agnostic

The resend cooldown is keyed by **address alone**, not by address-and-purpose.
A customer who asks for a sign-in code and then asks for a signup code is
still held to one request a minute.

If the cooldown were per purpose, the two flows would be two independent
mail budgets for one mailbox — which is exactly the way to get an address
suspended by Gmail, and the customer is the one who pays for it.

---

## 9. Marking the accounts that already exist

An existing deployment has accounts registered before the gate existed. They
have no `emailVerifiedAt`, so the gate would lock every one of them out.

`scripts/mark-existing-users-verified.ts` marks them.

It is a **script, not a migration**, and that is the whole point. A
migration that sets the timestamp for every existing row would silently mark
every account in every deployment as verified — including the ones that
registered with somebody else's address and never proved anything. The
decision is an operational one, and it is made by a person who can see the
accounts.

---

## 10. The guard rails

| Rule | Where it lives | Why |
|------|-----------------|-----|
| Registration issues no session | `api/auth/register/route.ts` | The account is unproved; a cookie would be a session for an address the shop cannot reach |
| The account is created unverified | `register/route.ts` → `emailVerifiedAt: null` | The inertness must not depend on a database default |
| The role is never read from the request | `register/route.ts` → `UserRole.CUSTOMER` | Otherwise anyone could self-register as an admin |
| A failed mail does not undo the registration | `register/route.ts` | A customer whose mail server had a bad minute must not lose their address |
| The purpose is scoped in the lookup | `lib/auth/otp.ts` → `verifyOtp` | A signup code must not be a sign-in code |
| The purpose is scoped in the deletion | `otp.ts` → `requestOtp` | Asking for one code must not destroy the other flow's pending code |
| The gate is where the session is minted | `login/route.ts`, `verify-otp/route.ts` | A session that was never issued cannot be used |
| The refusal comes after the password check | `login/route.ts` | Otherwise the gate is an enumeration oracle |
| The verification is a conditional write | `lib/auth/verification.ts` → `updateMany` | Two concurrent requests cannot both claim the first verification |
| The code is deleted on use | `otp.ts` → conditional `deleteMany` | A used code is worthless, and the row must not survive it |
| The default purpose is `SIGNIN` | `lib/validation/otp.ts` | A request that does not say what the code is for is asking to sign in |
| The cooldown covers both purposes | `email_otp_attempts` | One mailbox, one mail budget |

---

## 11. Testing

| File | What it covers |
|------|----------------|
| `tests/auth/session.test.ts` | The cookie: httpOnly, `SameSite=Lax`, `secure` in production, `path: "/"`, and a `maxAge` that matches the token's own life |
| `tests/auth/destination.test.ts` | The redirect rule: an admin to `/admin`, a customer to `next`, and a `next` that cannot leave the site |
| `tests/api/register-route.test.ts` | Registration: no cookie, an unverified account, a `CUSTOMER` role, and an account that survives a failed mail |
| `tests/api/login-route.test.ts` | The login gate: a `403` for an unverified account, no cookie for one, and the ordering against the password check |
| `tests/api/otp-routes.test.ts` | Both OTP routes: the envelope, the status codes, the cookie, and the token's claims |
| `tests/auth/otp.test.ts` | The schemas: the purpose default, the purpose passthrough, and the refusal of an unknown purpose |
| `tests/integration/otp.test.ts` | The database: the purpose on the row, the two purposes as separate rows, and the cooldown counted once across both |
| `tests/integration/verification.test.ts` | The verification service: single use, a wrong code, a cross-purpose code, the row's deletion, and **exactly one** first verification under concurrency |

The integration suites stub the transport at its boundary and capture the
message that *would* have gone out, so the shape of the message is under
test while the network is not. Everything else is the real implementation
against the real table.

### The live check

`scripts/e2e-verify-flow.ts` covers the **journey** against the running
server and the real database — register, verify, use the session, try to
replay the code, try to cross the purposes:

```
npx tsx scripts/e2e-verify-flow.ts
```

The code is obtained by writing the same row the service would have
written (`scripts/capture-otp.ts` does the same thing), because it cannot
be read back out of the table and the server mails it to a real inbox. The
verification path it feeds is the real one: the code is hashed with the
row's id and compared in constant time, exactly as it is for a code that
arrived by mail.

