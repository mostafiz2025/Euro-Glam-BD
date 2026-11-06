# The AI Advisor — implementation guide

> **What this is.** The AI Advisor is the storefront's skincare adviser: a
> customer describes their skin (or attaches a photo), and gets product
> suggestions that fit their routine — with ingredient conflicts flagged
> when two things should not be used together.
>
> **Why it matters.** The platform already knew how to detect a conflict
> between two products. The advisor is what makes that knowledge *useful*:
> it puts the right products in front of the right customer, and it says
> plainly when something is a bad match.
>
> **The one rule.** *Code decides, the model phrases.* Everything the
> customer sees as a decision — which product, whether a conflict exists,
> how severe it is — is decided by code. The model may only word it.

---

## 1. The architecture

```
src/
├── app/
│   ├── advisor/
│   │   ├── page.tsx                        # The page (server component)
│   │   └── components/
│   │       ├── AdvisorChat.tsx             # The chat shell (client)
│   │       ├── DisclaimerBanner.tsx        # The permanent banner
│   │       ├── MessageBubble.tsx           # One message + its conflicts
│   │       ├── ProductRecommendationCard.tsx
│   │       └── SkinProfileForm.tsx         # The profile editor
│   └── api/
│       ├── advisor/
│       │   ├── chat/route.ts               # POST — the primary endpoint
│       │   ├── config/route.ts             # GET — the disclaimer
│       │   ├── conversations/route.ts      # GET — the list
│       │   ├── conversations/[id]/route.ts # GET, DELETE — one conversation
│       │   ├── profile/route.ts            # GET, PUT — the skin profile
│       │   └── profile/photo/route.ts      # POST — the profile photo
│       └── admin/advisor/
│           ├── config/route.ts             # GET, PUT — the AiConfig row
│           └── messages/route.ts           # GET — the monitoring view
├── lib/
│   ├── ai/
│   │   ├── index.ts                        # Provider selection
│   │   ├── provider.ts                     # The interface + the contract
│   │   ├── mock-provider.ts                # The deterministic provider
│   │   ├── openai-provider.ts              # The real provider
│   │   ├── service.ts                      # The orchestration layer
│   │   ├── conversations.ts                # The conversation service
│   │   └── disclaimer.ts                   # The disclaimer + its fallback
│   └── validation/advisor.ts               # Every advisor schema
```

---

## 2. The rules

### 2.1 Code decides, the model phrases

The provider's only job is to **word** an outcome code has already reached.
It is not allowed to decide whether a conflict exists, to downgrade a
severity, to add a product that was excluded, or to omit the disclaimer.

That is defended in three layers:

1. **The candidate list is built in code.** Only in-stock, admin-allowed
   products that survive the conflict engine reach the provider.
2. **The provider's output is validated.** A recommended id outside the
   allow-list is dropped, logged, and replaced with the deterministic set.
3. **The conflicts are re-attached after the call.** Whatever the provider
   said about conflicts is discarded. The code-decided conflicts are what
   the customer sees.

```ts
const allowed = resolveAllowedIds(request);
const invalid = response.recommendedProductIds.filter((id) => !allowed.has(id));

if (invalid.length > 0) {
  console.warn(
    `[advisor] Provider recommended ${invalid.length} product(s) outside the allow-list. Falling back to the deterministic set.`,
  );
  recommendedIds = candidates
    .slice(0, MAX_RECOMMENDATIONS)
    .map((candidate) => candidate.id);
}
```

### 2.2 The disclaimer is always present

The disclaimer is a **product requirement** (PRD §3.A) and the spec
(§5.4) makes it non-disableable by design. It is enforced in three
places, because a UI-only guarantee fails the moment somebody calls the
API directly:

| Where | What it does |
|---|---|
| `src/lib/ai/disclaimer.ts` | The hardcoded fallback. It ships even if the database is down. |
| `src/lib/ai/service.ts` | Attaches the disclaimer to every response, unconditionally. |
| `src/app/api/advisor/chat/route.ts` | Records the version on the message's `meta`. |
| `src/app/api/admin/advisor/config/route.ts` | Rejects an empty disclaimer. |

**The banner has no close button.** That is deliberate. A dismissible
disclaimer is decoration, not a disclaimer — and the most likely future
"improvement" to this screen (adding an X) would break a compliance
requirement while looking like a UX win.

The version number is bumped **only when the text actually changes**, so
the stamp keeps identifying exactly what the customer saw. A save that
touches the allow-list alone leaves the version alone.

### 2.3 A conversation belongs to exactly one user

Every read and every delete is scoped by `userId` in the `where` clause —
not checked in application code afterwards. A conversation id belonging to
somebody else returns `null`, exactly like one that does not exist.

The distinction matters: a `403` ("that conversation exists but is not
yours") confirms the id is real. A `404` does not. The service returns
`null` for both cases so the route can answer `404` for both.

### 2.4 The profile is only ever added to

The advisor is allowed to **add** a concern the customer raised. It is not
allowed to remove one, and it is not allowed to change the skin type — a
phrase in a chat message is weaker evidence than a profile field the
customer deliberately set.

The *form* replaces the list (unchecking a box must remove it), while the
*chat* only adds. The two never fight.

### 2.5 The provider call happens before the persistence

The provider call is the expensive step, and it happens **before** the
conversation is written. A provider failure must not leave a conversation
with a user message and no answer in it.

### 2.6 The rate limit is counted, not assumed

The advisor is a paid call to a model provider. The count comes from the
database rather than a process-local counter, so it holds across every
instance of the deployment. A process-local counter would be reset on
every restart and would not be shared between instances — which is exactly
when a cap is needed.

---

## 3. The endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| `POST` | `/api/advisor/chat` | customer | The primary turn. Multipart: `message`, optional `image`, optional `conversationId`. |
| `GET` | `/api/advisor/config` | customer | The disclaimer, for the banner before the first message. |
| `GET` | `/api/advisor/conversations` | customer | The list, newest first. `?cursor` + `?limit` (max 50). |
| `GET` | `/api/advisor/conversations/[id]` | customer | The full history with images. `404` if not owned. |
| `DELETE` | `/api/advisor/conversations/[id]` | customer | Cascades messages/images, purges storage. `404` if not owned. |
| `GET` | `/api/advisor/profile` | customer | The skin profile, or a default empty one. |
| `PUT` | `/api/advisor/profile` | customer | Updates the profile. |
| `POST` | `/api/advisor/profile/photo` | customer | Sets or clears the profile photo. |
| `GET` | `/api/admin/advisor/config` | admin | The `AiConfig` row. |
| `PUT` | `/api/admin/advisor/config` | admin | Updates it. An empty disclaimer is a `400`. |
| `GET` | `/api/admin/advisor/messages` | admin | The monitoring view. Filterable by conversation, customer, provider, date range. |

### The chat endpoint's error codes

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No valid session |
| 400 | `VALIDATION_ERROR` | Message empty and no image; message too long; unsupported image type |
| 413 | `PAYLOAD_TOO_LARGE` | Image > 5 MB |
| 404 | `NOT_FOUND` | `conversationId` not owned by the user |
| 429 | `RATE_LIMITED` | > 20 messages/hour/user |
| 500 | `INTERNAL_ERROR` | Anything else |

---

## 4. The image pipeline

An upload goes through four steps, and each one is checked from the
bytes rather than from what the client claims:

1. **The client-side size check** — a courtesy, not a control.
2. **The magic-byte detection** — the client can send `Content-Type:
   image/png` with a text file. It cannot change the file's header.
3. **The MIME cross-check** — the declared type must match the detected
   one. A mismatch is rejected rather than resolved in favour of either.
4. **The dimension cap** — a 40 000 × 40 000 PNG is a few hundred
   kilobytes on disk but expands to roughly 6 GB in memory once decoded.

The image is stored against the conversation, and the **message** records
which image is its own attachment in `meta.imageId`. The meta is the
join — the cascade needs the conversation, but a conversation may hold
several messages, each with its own photo.

### The profile photo

`AdvisorImage.conversationId` is required, so a photo set before any
conversation exists needs a home. Rather than weakening the schema, the
profile photo route keeps a dedicated conversation per customer, marked
by the title `__profile_photo__`, and it is filtered out of every
customer-facing list.

---

## 5. The UI

### The page

`/advisor` is a **request-time** route (`export const instant = false`).
The session is read at the top of the page, outside the `<Suspense>`
boundary, because a dynamic read inside a boundary defers that boundary
indefinitely — the fallback is sent and the real content never arrives.

The customer sees a signed-out prompt rather than a `401`. The advisor
belongs to an account, so a visitor without a session cannot have one; a
`401` would be technically true and useless.

### The components

| Component | What it does |
|---|---|
| `AdvisorChat` | The shell. Manages the transcript, the composer, the attachment, the pending state. |
| `DisclaimerBanner` | The permanent banner. **No dismiss affordance.** |
| `MessageBubble` | One message, its conflicts, and its recommendation cards. |
| `ProductRecommendationCard` | The product, its price, its code-written reason, and an "Add to bag" that uses the ordinary cart API. |
| `SkinProfileForm` | The skin type and the concern chips. |

### The client rules

- **The envelope is checked, not assumed.** Every call discriminates on
  `ok` first.
- **A pending turn is not duplicated.** The `isPending` state is the
  single source of truth, so two rapid Enter presses produce one request.
- **The optimistic bubble is replaced, not merged.** The server's answer
  replaces the placeholder, so the server remains the authority.
- **The recommendation card uses the ordinary cart API.** The cart's
  conflict rules apply identically — there is no second, more permissive
  path.

---

## 6. Verification

```bash
# The unit and integration suites
DATABASE_URL="postgresql://.../euro_glam_bd_test?schema=public" npx vitest run

# The advisor's five load-bearing properties, against a real database
DATABASE_URL="postgresql://.../euro_glam_bd_test?schema=public" \
  npm run verify:advisor
```

`verify:advisor` proves:

1. **Conversation ownership** — another user's id returns `null`.
2. **The disclaimer is always present** — including the fallback when the
   `AiConfig` text is blank.
3. **Code decides, the model phrases** — a provider that invents a
   product id has it dropped.
4. **The conflicts are re-attached** — a provider that denies the
   conflicts cannot remove them.
5. **The profile is only ever added to** — the skin type survives a turn.
6. **The catalogue boundary** — an out-of-stock product is never
   recommended.

---

## 7. The provider

`AI_PROVIDER` chooses the implementation, read **at call time**:

- `mock` (the default) — deterministic, offline, byte-identical output
  for identical input. It is what CI asserts against and what the demo
  runs on.
- `openai` — the real provider. Requires `OPENAI_API_KEY`.

An unrecognised value falls back to `mock` with a loud warning — a typo
in a deployment variable should degrade to a working offline provider,
not take the storefront down. But a *missing credential* throws: a
deployment that would produce real advice must fail loudly, not silently
fall back to canned output.

---

## 8. What is deliberately not here

- **A moderation workflow for advisor messages.** PRD §4 asks the admin
  to "monitor chatbot recommendations". The admin's message list
  provides that visibility. An explicit approve/reject workflow is not
  included, because the AI's output is deterministic and rule-governed —
  there is nothing for a human to arbitrate.

- **A skin-type inference.** The advisor never sets the skin type. The
  customer picks it.

- **An image-analysis claim.** The advisor accepts a photo, but it does
  not diagnose conditions from it, and the system prompt forbids it. A
  model that says "you have rosacea" is a compliance failure, not a
  feature.

- **A streaming response.** The answer arrives whole. Streaming a model
  response would mean streaming a *decision* the code has already made,
  and the guard rails are easier to hold on a complete response.
