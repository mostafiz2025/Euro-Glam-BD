# Step 23 — Email Sign-In by One-Time Password

Implementation guide for the Euro Glam BD MVP.

This document explains **why** the code is shaped the way it is. The code
itself is the specification; this is the reasoning behind it.

---

## 0. The shape of the whole thing

```
src/
  app/api/
    auth/send-otp/route.ts     POST  issue a code and mail it
    auth/verify-otp/route.ts   POST  validate the code, set the session
  app/(storefront)/
    sign-in-code/page.tsx      the two-step sign-in page
  components/
    commerce/otp-sign-in-form.tsx
  lib/
    email.ts                   the Gmail SMTP transport
    auth/otp.ts                issue / verify, the rules
    validation/otp.ts          the schemas and the limits
prisma/
  schema.prisma                EmailOtp, EmailOtpAttempt
  migrations/…_email_otps/
  migrations/…_email_otp_attempts/
```

Four pieces, and each has one job:

| Piece | Job |
|-------|-----|
| `lib/email.ts` | Move a message. Knows nothing about OTPs. |
| `lib/auth/otp.ts` | Decide who may have a code, and whether a code is good. |
| `lib/validation/otp.ts` | What a valid request looks like, and what the limits are. |
| `app/api/auth/*-otp/route.ts` | Parse, delegate, shape a response. |

The rule that keeps this from rotting: **`lib/email.ts` knows nothing about
one-time passwords.** It sends messages. It does not know what a code is,
how long it lives, or how many guesses it gets. The OTP rules live in one
place, and the transport is a leaf.

---

## 1. The rule that governs the whole feature

**The email is a credential, and it must never be silently dropped.**

The storefront has a mock SMS gateway: it writes to a table instead of
sending, so a developer never messages a real customer by accident. That is
the right default for SMS, and it is the **wrong** default for email.

The email carries a one-time password — the thing that proves a customer
owns an inbox. An email that is silently dropped is not a degraded
experience; it is a sign-in that appears to work and then does not.

So there is **no mock driver** for email. If the transport cannot be built,
the module throws at first use and the route returns a `503` that says
exactly that. A deployment that cannot send email must **say so**, not look
healthy while delivering nothing.

The health endpoint reports `email: "configured" | "not-configured"` for the
same reason.

---

## 2. The transport

### Gmail SMTP, submission port, STARTTLS required

```ts
nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  requireTLS: true,
  auth: { user, pass },
});
```

Port **587** is the submission port: TLS is negotiated with STARTTLS rather
than from the first byte. Port 465 would be implicit TLS, which works too,
but 587 is what Google documents for authenticated submission and what most
hosts and firewalls expect.

`requireTLS: true` is **required, not optional**. Gmail refuses the
credentials over an unencrypted connection, and an app password is a bearer
secret — sending it in the clear would hand it to anyone on the path.
`requireTLS` makes Nodemailer refuse to fall back to plaintext rather than
trusting the server to negotiate it.

### Built lazily

`createTransport` reads the environment and validates the credentials.
Building it at module load would make the whole application fail to boot
when the mail settings are absent — including the storefront, which does not
need email to serve a product page.

The transport is therefore built on first use and cached. The cost is one
transport per process, which is what a pooled SMTP connection is for.

The cache distinguishes three states: not built yet, built, and *tried and
failed*. The third matters — a misconfigured deployment should not retry
the construction on every request and flood the logs.

### The `From` address falls back to the SMTP user

Gmail rejects a `From` header that is not an address on the authenticated
account, or a configured alias for it. So `EMAIL_FROM` is used when set, and
otherwise the message goes out as `"Euro Glam BD" <EMAIL_USER>`.

---

## 3. The OTP rules

### The code

Six digits, drawn with `crypto.randomInt(0, 1_000_000)` and zero-padded.

Six is the number customers already recognise from every other bank and OTP
in the world, and it is short enough to type on a phone without a keyboard.
It is also long enough that the space is a million values — which is only
safe because of the attempt limit, the expiry and the resend cooldown.

The code is drawn as a **number** and then padded, not as six independent
digit characters. One uniform draw over a million gives every six-digit
string exactly the same probability; picking digits independently makes the
leading-digit distribution depend on the implementation of the picker.

### The code is never stored

A row in `email_otps` is a live credential for as long as it has not
expired. It sits in the same database as customer addresses, orders and
reviews, and a dump of it is a list of credentials that work.

So the code is stored as a SHA-256 hash, **salted with the row's own id**:

```
sha256(`${otpId}:${code}`)
```

The salt is the row id because it is unique by construction, already in the
table, and it means two customers issued the same six digits do not have the
same stored value. Without it, the table would double as a precomputed
lookup of "which account does 123456 belong to?".

The salt is **not** a secret and does not need to be. Its job is to stop
precomputation and to stop two equal codes from being equal on disk.

**SHA-256 rather than bcrypt is deliberate, and it is the opposite of the
password rule.** A password hash is deliberately slow, because a password is
a secret the user chose and an attacker may try for years. A one-time code
is not that: six digits, ten minutes of life. A slow hash would cost the
shop CPU on every verification without making the code any harder to steal
from the database.

### It expires, it is single-use, it is attempt-limited

Three separate bounds, all necessary:

| Bound | Where | Why |
|-------|-------|-----|
| Ten minutes | `EmailOtp.expiresAt` | The deadline is a property of the *record*, so it survives a restart and cannot drift if the constant changes. |
| Single use | the row is deleted | A verified code is worthless. Keeping it — even as a consumed row — widens the window in which a leaked hash is useful. |
| Five guesses | `EmailOtp.attempts` | A million possibilities is a search space, not a wall. Five wrong guesses and the row is dead, however much time is left on it. |

The deletion is **conditional** — it only fires if the row is still there:

```ts
const deleted = await db.emailOtp.deleteMany({ where: { id: record.id } });
if (deleted.count === 0) return { ok: false };
```

Without the condition, two concurrent requests carrying the same valid code
would both read the row, both match, and both sign in. The conditional
delete makes exactly one of them the winner.

The attempt counter is a row **update** rather than a read-modify-write, so
two concurrent wrong guesses both land and neither is lost. The naive
version loses a count under a race — and a race is exactly when an
attacker is trying.

---

## 4. The resend cooldown, and the table it needed

The cooldown is sixty seconds per address.

The obvious place to count it is the OTP row: "when was the last code sent
to this address?" — and that is exactly what the row knows.

**But an address with no account never gets an OTP row**, because there is
nothing to sign in to. And that address is precisely the one an attacker
would probe.

A cooldown that only applies to real customers is not a cooldown at all — it
is a limit that excludes exactly the traffic it exists to stop. The
enumeration oracle would be wide open: probe a thousand addresses as fast
as the network allows, and the ones that answer `404` are the ones with no
customers, while the ones that answer `429` are the ones that do.

So the *attempts* are recorded separately, in `email_otp_attempts`, and every
request writes a row whether or not it produced a code. The cooldown is then
a question about that table, and it answers identically for an address with
an account and one without.

### What the ledger does not hold

The address and the time. **Not** whether the address had an account, and
**not** whether a code was sent.

A table that recorded the outcome would be a table that says which addresses
belong to customers — which is the very thing the endpoint must not reveal,
and which a dump of this database would then hand over wholesale.

The integration suite asserts that the row written for an address with an
account and the row written for one without have the **same shape**, so the
distinction cannot be added later by accident.

---

## 5. The two endpoints

### `POST /api/auth/send-otp`

```
{ "email": "customer@example.com" }
```

| Outcome | Status | Body |
|---------|--------|------|
| Code issued and mailed | `200` | `{ ok: true, data: { sent: true } }` |
| No account at that address | `404` | `NOT_FOUND` |
| Asked again too soon | `429` | `RATE_LIMITED` |
| Mail not configured | `503` | `SERVICE_UNAVAILABLE` |
| Message refused by the server | `503` | `SERVICE_UNAVAILABLE` |
| Body failed validation | `400` | `VALIDATION_ERROR` |

The endpoint **does** distinguish "no account here" from "code sent",
because a customer who asks for a code at an unknown address needs to be
told so — otherwise they wait for an email that will never arrive. The
cooldown is what keeps that answer from being a cheap enumeration oracle.

Both `503`s are the same status with different messages, and neither is a
`500`: a `500` says "the shop has a bug", and neither of these is a bug.

### `POST /api/auth/verify-otp`

```
{ "email": "customer@example.com", "code": "123456" }
```

| Outcome | Status |
|---------|--------|
| Code accepted | `200`, plus the session cookie |
| Any failure | `401` |
| Body failed validation | `400` |

**Every** verification failure is the same failure. A mistyped code, an
expired code, a code that was never issued, a code that has already been
used, and a code that has run out of attempts all produce one `401`, with
the same message and no details.

If they produced different answers, the endpoint would tell an attacker how
close they were. "This code exists but has expired" is a fact about a
customer's account; "this code has five attempts left" is an invitation to
try them.

### Both are public in the proxy

`src/proxy.ts` → `PUBLIC_PATHS`. They are public **by necessity**, not by
convenience: they are the sign-in path for a customer who has no session
yet. Requiring a session to obtain a session makes the flow impossible.

They are protected by something else entirely — the mailed code, which is
attempt-limited, single-use and expires.

---

## 6. The page

`/sign-in-code`, reachable from `/login`.

The form has two steps and the step is the state: give an address, the shop
mails a code, type the code. The address is **not** re-read from the input
when the code is verified, because the input has been replaced by the code
box by then.

Three rules the component follows:

1. **The envelope is checked before the data is read.** Reading `data`
   without checking `ok` first is the classic way to show `undefined` and
   call it a success.
2. **The code is never echoed back.** A code that has been typed and
   rejected is cleared, so the credential is not left in the DOM. The same
   rule the password form follows.
3. **An admin lands in the console.** The response carries the role, and
   `destinationAfterSignIn` decides the destination — the same helper the
   password form uses.

The code input is `inputMode="numeric"`, `pattern="[0-9]{6}"` and
`maxLength={6}`, so a phone shows the number pad.

---

## 7. The guard rails

| Rule | Where it lives | Why |
|------|-----------------|-----|
| A missing mail credential is a hard failure | `lib/email.ts` → `readSmtpConfig` | A dropped OTP is a sign-in that appears to work and does not |
| STARTTLS is required | `lib/email.ts` → `requireTLS: true` | Gmail refuses the credentials in the clear |
| The transport is built lazily | `lib/email.ts` → `getTransport` | The storefront must still boot without mail settings |
| A malformed port is reported, not corrected | `lib/email.ts` → `readPort` | A deployment that meant 465 and got a typo should be told |
| The code is never stored | `schema.prisma` → `EmailOtp.codeHash` | A dump of the table must not be a list of codes that work |
| The code is single-use | `lib/auth/otp.ts` → `verifyOtp` | A verified code is worthless |
| The code expires after ten minutes | `EmailOtp.expiresAt` | The deadline is a property of the record |
| Five wrong guesses kill the code | `EmailOtp.attempts` | Six digits is a search space, not a wall |
| The cooldown covers unknown addresses too | `email_otp_attempts` | A limit that excludes the traffic it exists to stop is not a limit |
| The attempt ledger records no outcome | `EmailOtpAttempt` has only `email` and `createdAt` | A dump of the database must not be the customer list |
| One failure, not five | `app/api/auth/verify-otp/route.ts` | Different answers would tell an attacker how close they were |
| The endpoints are public | `proxy.ts` → `PUBLIC_PATHS` | Requiring a session to obtain a session makes the flow impossible |
| The health endpoint reports the mail state | `app/api/health/route.ts` | A broken sign-in should show on a dashboard, not at the sign-in screen |

---

## 8. Testing

| File | What it covers |
|------|----------------|
| `tests/auth/email.test.ts` | The configuration: Gmail defaults, missing credentials, a malformed port |
| `tests/auth/otp.test.ts` | The primitives: uniform codes, the salted hash, the schemas, the limits |
| `tests/api/otp-routes.test.ts` | The routes: the envelope, the status codes, the cookie, the 503 paths |
| `tests/integration/otp.test.ts` | The database: the hash on disk, single use, the attempt limit, the expiry, the cooldown for **unknown** addresses |

The integration suite stubs the transport at its boundary and captures the
message that *would* have gone out — so the shape of the message is under
test while the network is not. Everything else is the real implementation
against the real table.
