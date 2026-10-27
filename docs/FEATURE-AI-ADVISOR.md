# Feature Specification — AI Advisor Chat + Skin Profile Capture

**Project:** Euro Glam BD
**Feature:** AI Advisor chat with image upload, skin-profile capture, product recommendation, and conflict-aware advice
**Status:** Specified, not yet implemented
**Depends on:** `DECISIONS.md` (all 12 locked decisions)

---

## 1. Scope

### 1.1 In scope

| Capability | Requirement source | PRD ref |
|---|---|---|
| User uploads a photo of their face/skin alongside a free-text query | §3.A | A |
| System analyses the image + query and returns product recommendations | §3.A | A |
| Mandatory non-medical disclaimer visible throughout the chat session | §3.A | A |
| Capture/update a persistent skin profile (skin type, concerns) | §2 `User_Skin_Profiles` | A |
| Recommendations respect ingredient conflicts with products already in the cart | §3.B | B |
| Deterministic ingredient conflict evaluation surfaced in the chat | §3.B | B |
| Admin monitoring of AI recommendations | §4 | — |
| Admin control over the disclaimer and product→AI mapping | §4 | — |

### 1.2 Explicitly out of scope for this feature

- Real medical diagnosis, condition identification, or prescription. The disclaimer is not decorative — it is a product requirement enforced at the service layer (§5.4).
- Voice input, streaming token-by-token output, multi-language chat.
- Live "AI training" on uploaded photos. Uploaded images are analysed then discarded unless a user explicitly saves one to their profile (§3.2).
- Admin CRUD for products/categories/orders — separate features. This spec consumes those models but does not build their admin screens.
- The SMS reminder pipeline (locked decision #9) — separate feature.

### 1.3 Non-goals that constrain design

- **No LLM in the safety path.** The conflict engine is pure code. The LLM may only *phrase* an outcome that code already decided (§5.3).
- **No photo retention without consent.** Faces are biometric-adjacent. Default is ephemeral.

---

## 2. Domain model

### 2.1 New Prisma models

Five models are added. Three are new concepts; two are extensions of existing PRD models.

```prisma
// ─────────────────────────────────────────────────────────────
// AI Advisor — conversation
// ─────────────────────────────────────────────────────────────

model AdvisorConversation {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  title        String?  @db.VarChar(160)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  lastMessageAt DateTime @default(now())

  messages     AdvisorMessage[]
  images       AdvisorImage[]

  @@index([userId, lastMessageAt(sort: Desc)])
  @@map("advisor_conversations")
}

model AdvisorMessage {
  id             String   @id @default(cuid())
  conversationId String
  conversation   AdvisorConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  role           MessageRole
  content        String   @db.Text

  /// AI provider + model that produced this message, for auditability.
  provider       String?  @db.VarChar(40)
  model          String?  @db.VarChar(80)
  /// True when the mock provider produced it (never a paid real call).
  isMocked       Boolean  @default(false)

  /// Structured payload: recommended product ids, conflicts detected,
  /// disclaimer version shown, skin-profile snapshot. Nullable = free-form chat.
  meta           Jsonb?

  createdAt      DateTime @default(now())

  @@index([conversationId, createdAt])
  @@map("advisor_messages")
}

enum MessageRole {
  USER
  ASSISTANT
  SYSTEM
}

// ─────────────────────────────────────────────────────────────
// Uploaded images
// ─────────────────────────────────────────────────────────────

model AdvisorImage {
  id             String   @id @default(cuid())
  conversationId String
  conversation   AdvisorConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  /// Storage adapter key, e.g. "local" or "cloudinary". Never a raw URL —
  /// URLs are derived via the adapter so the driver can change.
  storageKey     String   @db.VarChar(200)
  /// MIME type actually detected server-side from magic bytes (not client-declared).
  mimeType       String   @db.VarChar(100)
  byteSize       Int
  width          Int?
  height         Int?

  /// Set when the user explicitly saves this image to their skin profile.
  isProfilePhoto Boolean  @default(false)
  /// Set when the admin deletes it; the file is purged from the adapter.
  isDeleted      Boolean  @default(false)

  createdAt      DateTime @default(now())

  @@index([conversationId])
  @@map("advisor_images")
}

// ─────────────────────────────────────────────────────────────
// Skin profile — extends the PRD's User_Skin_Profiles
// ─────────────────────────────────────────────────────────────

model UserSkinProfile {
  id               String   @id @default(cuid())
  userId           String   @unique
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  skinType         SkinType?
  concerns         String[] @default([])

  /// Retains a photo the user explicitly consented to keep.
  profileImageId   String?
  profileImage     AdvisorImage? @relation(fields: [profileImageId], references: [id], onDelete: SetNull)

  /// Free-text notes the user gives about their skin.
  notes            String?  @db.Text

  /// ISO date (YYYY-MM-DD) the user says the product will run out.
  /// User-provided — never inferred. See DECISIONS.md.
  estimatedEmptyAt DateTime?

  /// Explicit SMS consent for the expiry reminder (locked decision #9).
  smsOptIn         Boolean  @default(false)

  lastAnalysisDate DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@map("user_skin_profiles")
}

enum SkinType {
  NORMAL
  DRY
  OILY
  COMBINATION
  SENSITIVE
  ACNE_PRONE
  UNKNOWN
}

// ─────────────────────────────────────────────────────────────
// Disclaimer + AI configuration control (admin)
// ─────────────────────────────────────────────────────────────

model AiConfig {
  id        String   @id @default(cuid())
  /// Single-row table guarded in the service layer.
  key      String   @unique @db.VarChar(40)   // e.g. "default"

  /// Exact text shown to users. Admin-editable, but the service layer
  /// refuses to disable it — see §5.4.
  disclaimerText String @db.Text
  /// Bumped whenever disclaimerText changes; stamped onto every message's
  /// meta so an audit can prove which version a user actually saw.
  disclaimerVersion Int @default(1)

  /// Admin-managed allow-list of products the AI may recommend.
  aiProductIds   String[] @default([])
  /// Admin-managed prompt/instruction override for the AI provider.
  systemPrompt   String?  @db.Text
  /// When true the AI must not recommend a product that conflicts with
  /// anything in the user's cart.
  enforceCartConflicts Boolean @default(true)

  updatedAt DateTime @updatedAt

  @@map("ai_configs")
}
```

### 2.2 Field-level design notes

**`AdvisorMessage.meta` is `Jsonb`, not `Json`.** A plain `Json` column cannot be compared in `.where()` at all; `Jsonb` is filterable. The admin moderation query needs to find messages whose meta contains a given product id, so filterability is a requirement, not a nicety.

**`AdvisorImage.storageKey` is not a URL.** Storing a URL bakes the storage driver into the data. Storing a key means the `local` → `cloudinary` swap is a config change plus one adapter method, with no data migration.

**`UserSkinProfile.estimatedEmptyAt` is user-provided.** The PRD says the system "calculates when a skincare product is likely to finish" from volume and average usage. Inferring this from order data would be fabricated precision — we do not know how fast someone uses a 30ml bottle. The user tells us; the system schedules around it.

**`AiConfig.aiProductIds String[]` is not indexed.** Scalar lists are PostgreSQL-only and `@@index` on them is undocumented/unsupported. The admin loads the full list and filters in application code — the MVP product catalogue is small enough that this is free.

**`AdvisorImage.profileImageId` uses `onDelete: SetNull`.** A deleted photo should not delete the skin profile — the profile is the user's data, the photo is a pointer. This is the one place `SetNull` is correct, and it is explicit rather than inherited from Prisma's default.

**`AdvisorConversation` cascades to messages/images.** These are sub-resources of a conversation with no independent meaning. A conversation is deleted only with its owner (user cascade), or by an explicit admin action.

### 2.3 Required changes to existing models

```prisma
model User {
  // ... existing fields unchanged ...
  advisorConversations AdvisorConversation[]
  skinProfile          UserSkinProfile?
}

model Product {
  // ... existing fields unchanged ...
  /// Canonical ingredient IDs (AHA, BHA, RETINOL, VITAMIN_C, ...)
  /// used by the deterministic conflict engine. Populated by admin from
  /// the static catalogue — never fuzzy-matched at runtime.
  ingredientTags  String[] @default([])
  /// Free-text ingredients for the PDP ingredients section (PRD §3.F).
  ingredients     Jsonb    @default("{}")
  /// Legacy fields from the SRS kept for the home page / flash sales.
  discountPrice   Int?     // poisha
  discountPercentage Int?
  climateTips     String?  @db.Text
  isNewArrival    Boolean  @default(false)
  isBestSeller    Boolean  @default(false)
  /// Centred on Product for the category filter; see §2.4.
  category       Category @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  categoryId     String
}
```

**Money is `Int` poisha.** 1 BDT = 100 poisha. `price` in the PRD/SRS is a number — it is stored as `pricePaisa Int` and formatted at the edges. `Float` is excluded outright.

**`ingredients` becomes `Jsonb @default("{}")`.** The PRD's ingredient data is a list, so the actual default in the migration will be `[]`; `"{}"` is the Prisma attribute default. The shape is validated by Zod at the admin boundary, so a malformed `ingredients` value can only enter the database through a code path that bypasses validation — which is why the shape is also asserted in a type guard when read.

**`category` is `onDelete: Restrict`.** Deleting a category that still has products would orphan them. `Restrict` makes the admin delete the products first. This is explicit, not inherited.

---

## 3. Data flow

### 3.1 Chat with image — the main flow

```
User                    Client                 API (route handler)          Services                  Prisma
 │                        │                            │                          │                       │
 │ [pick image + text]    │                            │                          │                       │
 ├───────────────────────>│                            │                          │                       │
 │                        │ POST /api/advisor/chat    │                          │                       │
 │                        │ (multipart: message,      │                          │                       │
 │                        │  image, conversationId?)   │                          │                       │
 │                        ├───────────────────────────>│                          │                       │
 │                        │                    auth → requireUser()            │                       │
 │                        │                    zod parse → UploadService       │                       │
 │                        │                            ├────────────────────────>│                       │
 │                        │                            │  validateMagicBytes()   │                       │
 │                        │                            │  storage.put()          │                       │
 │                        │                            │<────────────────────────┤                       │
 │                        │                            │                          │                       │
 │                        │                            │ transaction:            │                       │
 │                        │                            │  create Conversation ───┼──────────────────────>│
 │                        │                            │  create Image ──────────┼──────────────────────>│
 │                        │                            │  create USER message ───┼──────────────────────>│
 │                        │                            │                          │                       │
 │                        │                            │ AiService.generate()    │                       │
 │                        │                            │  ├─ load profile ───────┼──────────────────────>│
 │                        │                            │  ├─ load cart products ┼──────────────────────>│
 │                        │                            │  ├─ load candidates ────┼──────────────────────>│
 │                        │                            │  ├─ conflictEngine.evaluate()  (PURE)              │
 │                        │                            │  │    ├─ BLOCK → drop candidate, record conflict       │
 │                        │                            │  │    └─ WARN  → keep candidate, attach note          │
 │                        │                            │  └─ aiProvider.complete()  (mock|openai)            │
 │                        │                            │<────────────────────────┤                       │
 │                        │                            │ transaction:            │                       │
 │                        │                            │  create ASSISTANT msg ─┼──────────────────────>│
 │                        │                            │  upsert profile ────────┼──────────────────────>│
 │                        │                            │                          │                       │
 │                        │  200 { message, products, │                          │                       │
 │                        │         conflicts,        │                          │                       │
 │                        │         disclaimer }      │                          │                       │
 │                        │<───────────────────────────┤                          │                       │
 │ [render chat +         │                            │                          │                       │
 │  disclaimer banner]    │                            │                          │                       │
```

### 3.2 Image lifecycle

The retention rule differs by user action, and the distinction matters:

| Scenario | Image stored | Retained? |
|---|---|---|
| Uploaded for analysis, not saved | Yes, in `AdvisorImage` | Purged from storage by a scheduled cleanup job after N days (default 30); DB row flagged `isDeleted` |
| Saved to profile by user | Yes | Kept until user deletes it or account is deleted |
| Uploaded and the message is deleted | Yes | Purged immediately |
| Account deleted | Cascades | Purged by cleanup job (FK cascade cannot reach the filesystem) |

**Key point:** the DB cascade cannot delete files on disk. A `cleanupOrphanedImages` job is required, or the disk fills up with orphans. This is called out here because it is the single most commonly missed step in a local-storage implementation.

### 3.3 Conversation lifecycle

- A conversation is created implicitly on first message if no `conversationId` is supplied.
- A conversation belongs to exactly one user. Passing another user's `conversationId` returns `404` (not `403` — do not leak existence).
- Deleting a conversation cascades to its messages and images; images are queued for storage purge.

### 3.4 Disclaimer propagation

The disclaimer is delivered three ways, and all three must hold:

1. **API response** — every chat response includes `disclaimer: { text, version }`.
2. **Persisted in message meta** — `meta.disclaimerVersion` records what the user was shown, so a later dispute can be answered factually.
3. **Client component** — the chat shell renders the disclaimer as a persistent, non-dismissible banner above the message list, plus an inline footer on each AI message.

The banner is **not dismissible** because PRD §3.A requires it "visible during the chat session". Making it dismissible would violate the requirement.

---

## 4. API surface

All routes are `src/app/api/**/route.ts`. All mutating routes require a session. All responses are JSON with a consistent envelope.

### 4.0 Response envelope

```ts
// src/lib/api/types.ts
export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = {
  ok: false;
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
};
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "AI_PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";
```

### 4.1 `POST /api/advisor/chat`

Multipart. The primary endpoint.

**Request**

| Field | Type | Rules |
|---|---|---|
| `message` | string | 1–2000 chars, trimmed. Optional **only if** `image` is present. |
| `image` | file | Optional. ≤5MB. Allowed MIME: `image/jpeg`, `image/png`, `image/webp`. |
| `conversationId` | string | Optional cuid. If omitted, a conversation is created. |
| `saveAsProfilePhoto` | boolean | Optional, default `false`. |

**Response** — `200`

```ts
{
  ok: true,
  data: {
    conversationId: string;
    message: {
      id: string;
      role: "ASSISTANT";
      content: string;
      createdAt: string;
    };
    recommendations: Array<{
      productId: string;
      name: string;
      pricePaisa: number;
      discountPricePaisa: number | null;
      reason: string;
    }>;
    conflicts: Conflict[];
    skinProfile: { skinType: SkinType | null; concerns: string[] };
    disclaimer: { text: string; version: number };
    provider: { name: string; isMocked: boolean };
  }
}
```

**Error responses**

| Status | Code | Condition |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No valid session |
| 400 | `VALIDATION_ERROR` | Message empty and no image; message too long; unsupported image type |
| 413 | `PAYLOAD_TOO_LARGE` | Image > 5MB |
| 404 | `NOT_FOUND` | `conversationId` not owned by user |
| 429 | `RATE_LIMITED` | > 20 messages/hour/user |
| 500 | `AI_PROVIDER_ERROR` | Provider threw and the mock fallback also failed |
| 500 | `INTERNAL_ERROR` | Anything else |

### 4.2 `GET /api/advisor/conversations`

Paginated list for the signed-in user, newest first. `?cursor` + `?limit` (max 50).

### 4.3 `GET /api/advisor/conversations/[id]`

Full message history with images. `404` if not owned by the user.

### 4.4 `DELETE /api/advisor/conversations/[id]`

Cascades messages/images, queues storage purge. `404` if not owned.

### 4.5 `GET /api/advisor/profile`

Returns the current `UserSkinProfile`, or a default empty profile.

### 4.6 `PUT /api/advisor/profile`

Updates `skinType`, `concerns`, `notes`, `estimatedEmptyAt`, `smsOptIn`.

**Validation:** `skinType` must be a `SkinType` enum member; `concerns` must be a subset of the static `SKIN_CONCERNS` catalogue (max 10); `estimatedEmptyAt` must be a future ISO date; `smsOptIn` is boolean.

**Note on `smsOptIn`:** changing it here is the single opt-in point for locked decision #9. There is no separate SMS route for now — one less surface.

### 4.7 `GET /api/advisor/config`

Public-ish (session required, no admin): returns the current disclaimer text and version, so the client can render the banner even before the first message.

### 4.8 `GET /api/admin/advisor/messages` *(admin)*

Paginated list of all advisor messages, filterable by `?conversationId`, `?isMocked`, `?from`, `?to`. Supports PRD §4 "Monitor chatbot recommendations".

### 4.9 `GET|PUT /api/admin/advisor/config` *(admin)*

Reads and updates `AiConfig`: disclaimer text, allowed product ids, system prompt, `enforceCartConflicts`.

**Constraint:** the disclaimer cannot be emptied or set to whitespace. The route returns `400 VALIDATION_ERROR` if the trimmed text is empty. The requirement is non-disableable by design.

### 4.10 `POST /api/advisor/profile/photo` *(optional endpoint)*

Separate route to set/clear the profile photo, so the user can change their saved photo without starting a new conversation. Accepts multipart `image` (same validation) and `clear` boolean.

---

## 5. Service layer

```
src/
├── app/
│   ├── api/
│   │   ├── advisor/
│   │   │   ├── chat/route.ts
│   │   │   ├── profile/route.ts
│   │   │   ├── profile/photo/route.ts
│   │   │   ├── config/route.ts
│   │   │   └── conversations/
│   │   │       ├── route.ts
│   │   │       └── [id]/route.ts
│   │   └── admin/
│   │       └── advisor/
│   │           ├── messages/route.ts
│   │           └── config/route.ts
│   ├── advisor/                    # UI
│   │   ├── page.tsx
│   │   └── components/
│   └── ...
├── lib/
│   ├── ai/
│   │   ├── provider.ts             # AiProvider interface
│   │   ├── mock-provider.ts
│   │   ├── openai-provider.ts
│   │   └── service.ts              # orchestration
│   ├── conflicts/
│   │   ├── catalogue.ts            # canonical ingredient IDs + aliases
│   │   ├── rules.ts                # declarative rule array
│   │   └── engine.ts               # pure evaluateConflicts()
│   ├── storage/
│   │   ├── adapter.ts              # StorageAdapter interface
│   │   └── local-driver.ts
│   ├── auth/
│   │   ├── jwt.ts                  # sign/verify
│   │   ├── session.ts              # cookie helpers
│   │   └── guards.ts               # requireUser, requireAdmin
│   ├── validation/
│   │   └── schemas.ts
│   ├── db.ts                       # Prisma singleton
│   └── api/
│       ├── types.ts
│       └── respond.ts
└── types/
    └── advisor.ts
```

### 5.1 `AiProvider` interface

```ts
// src/lib/ai/provider.ts
export type SkinContext = {
  skinType: SkinType | null;
  concerns: string[];
  notes: string | null;
};

export type ProductCandidate = {
  id: string;
  name: string;
  categoryName: string;
  pricePaisa: number;
  discountPricePaisa: number | null;
  ingredientTags: string[];
  climateTips: string | null;
  description: string;
};

export type ConflictReport = {
  ruleId: string;
  severity: "BLOCK" | "WARN";
  title: string;
  message: string;
  involvedProductIds: string[];
  ingredientIds: string[];
};

export type AdvisorRequest = {
  userMessage: string;
  image?: { mimeType: string; base64: string };  // base64 only for real provider
  profile: SkinContext;
  candidates: ProductCandidate[];
  conflicts: ConflictReport[];
  allowedProductIds: string[] | null;   // null = all
  systemPrompt: string | null;
};

export type AdvisorResponse = {
  content: string;
  recommendedProductIds: string[];
  providerName: string;
  modelName: string;
  isMocked: boolean;
};

export interface AiProvider {
  readonly name: string;
  readonly modelName: string;
  complete(request: AdvisorRequest): Promise<AdvisorResponse>;
}
```

**Critical:** `complete()` receives candidates and conflicts **already filtered and decided by code**. The provider's only job is to phrase an answer. It cannot add a product that code excluded, because the response validator (§5.5) rejects any recommended id not in the candidate list.

### 5.2 Providers

**Mock** (`src/lib/ai/mock-provider.ts`) — deterministic. Given the same input it must produce the same output. Implementation: derive a seed from a hash of `userMessage + sorted candidate ids + sorted conflict rule ids`; use that seed to pick from canned response templates. It must **not** use `Math.random()` or `Date.now()`.

Why deterministic: the demo must be reproducible, and CI tests must assert exact output. It also proves the app works with no API key — important for a project that will be run by other people.

**OpenAI** (`src/lib/ai/openai-provider.ts`) — real implementation, active only when `AI_PROVIDER=openai`. Sends the image as a base64 data URL in a vision message. Must never be imported at module scope when the flag is off, so the SDK is not loaded in mock mode.

**Selection** (`src/lib/ai/index.ts`):

```ts
export function getAiProvider(): AiProvider {
  if (process.env.AI_PROVIDER === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("AI_PROVIDER=openai requires OPENAI_API_KEY");
    }
    return new OpenAiProvider();
  }
  return new MockProvider();
}
```

### 5.3 Conflict engine — pure and deterministic

```ts
// src/lib/conflicts/engine.ts
export type IngredientId = string;  // canonical ID, e.g. "RETINOL"

export type ConflictRule = {
  id: string;
  ingredientA: IngredientId;
  ingredientB: IngredientId;
  severity: "BLOCK" | "WARN";
  title: string;
  message: string;
  /// Guidance on how to use them safely together, if at all.
  remedy: string;
};

export type EvaluatedConflict = {
  ruleId: string;
  severity: "BLOCK" | "WARN";
  title: string;
  message: string;
  remedy: string;
  involvedProductIds: string[];
  ingredientIds: IngredientId[];
};

export type ConflictEvaluation = {
  conflicts: EvaluatedConflict[];
  blockedProductIds: string[];
  warnedProductIds: string[];
};
```

**The engine is a pure function.** Signature: `evaluateConflicts(products: ProductCandidate[], rules: ConflictRule[]): ConflictEvaluation`. It performs no I/O, no clock reads, no randomness, and no AI calls. Given the same inputs it returns the same output — which is what makes it unit-testable and trustworthy for safety decisions.

The rules live in `src/lib/conflicts/rules.ts` as a plain array. The catalogue in `catalogue.ts` maps canonical IDs to display names and admin-facing aliases.

**Why code, not LLM** — three concrete reasons, not a preference:
1. *Correctness* — an LLM asked "do retinol and AHA conflict?" will sometimes say no. A `BLOCK` rule in code cannot be wrong.
2. *Auditability* — a safety warning must be explainable to a customer and defensible to a regulator. "Rule AHA_RETINOL, severity BLOCK" is explainable; "the model said so" is not.
3. *Cost and latency* — the conflict check runs on every add-to-cart. A rule array is microseconds; an LLM round-trip is seconds and money.

**The LLM only phrases the result.** `message` and `remedy` in the rules are human-authored defaults. The provider may rephrase them for tone and locale, but it may not change the severity or drop a conflict.

**Ordering guarantee:** conflicts are sorted by severity (`BLOCK` first), then by `ruleId`. Deterministic output ordering matters for tests and for stable UI.

### 5.4 Disclaimer enforcement

The disclaimer requirement is enforced in three places, because a UI-only guarantee fails the moment someone calls the API directly.

1. **Service layer** — `AiService` reads the disclaimer from `AiConfig` and **always** attaches it to the response. If `AiConfig` is missing, it falls back to a hardcoded constant — never to "no disclaimer".
2. **Persistence** — `disclaimerVersion` is written into `AdvisorMessage.meta` on every assistant message. An audit can prove which version each user saw.
3. **Admin route** — `PUT /api/admin/advisor/config` rejects an empty disclaimer.

**Hardcoded fallback constant** (in `src/lib/ai/service.ts`, or a dedicated `src/lib/ai/disclaimer.ts`):

```
This is an aesthetic/skincare suggestion, not a medical prescription from a doctor.
```

**Also enforced in the prompt.** When a real provider is active, the system prompt instructs it to:
- never claim to diagnose a condition,
- never recommend prescription-strength actives,
- always encourage consulting a dermatologist for persistent concerns,
- refuse image analysis claims about specific conditions (e.g. "this is eczema") and redirect to a professional.

The mock provider must satisfy the same behavioural contract in its canned responses, so switching providers does not change the product's promises.

### 5.5 Response validation — the guard rail

The provider's output is untrusted input. After `complete()` returns:

```ts
// Recommended product ids must be a subset of what code decided to offer.
const allowed = new Set(candidates.map(c => c.id));
const invalid = response.recommendedProductIds.filter(id => !allowed.has(id));
if (invalid.length > 0) {
  // Drop them, log, and fall back to the deterministic recommendation set.
  // Never surface a product the pipeline did not approve.
}
```

The same applies to conflicts: the provider may rephrase but may not remove a `BLOCK` conflict or downgrade a severity. The service re-attaches the code-decided conflicts to the response after the provider returns, overriding any provider-supplied version. **Code wins, always.**

### 5.6 Storage adapter

```ts
// src/lib/storage/adapter.ts
export type StoredObject = {
  key: string;        // e.g. "advisor/2026/10/ab12cd34.webp"
  byteSize: number;
  mimeType: string;
};

export interface StorageAdapter {
  put(input: {
    bytes: Buffer;
    mimeType: string;
    originalName: string;
    scope: string;     // e.g. "advisor" | "products" | "reviews"
  }): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;
  exists(key: string): Promise<boolean>;
}
```

**Local driver** writes to `public/uploads/<scope>/<yyyy>/<mm>/<random>.<ext>`. The filename is **generated**, never derived from user input — the original name is used only to pick a safe extension, and even that is chosen from an allow-list based on the *detected* MIME type, not the declared one.

**Upload validation** (the `UploadService`, used by both the chat route and the profile-photo route):

| Check | Rule |
|---|---|
| Declared MIME | Must be in the allow-list for the scope |
| Magic bytes | Must match the declared type. This is the real check — a client can lie about `Content-Type` but not about the file's actual header |
| Size | Images ≤ 5MB, videos ≤ 50MB, per scope |
| Dimensions | Reject > 4000px on either axis (decompression-bomb guard) |
| Filename | Regenerated, never user-controlled |
| Path traversal | The resolved path must remain inside the upload root — verify with `path.resolve` + a prefix check |
| Storage key | `scope/yyyy/mm/<32-hex-random>` — no user-derived segments at all |

### 5.7 Auth guards

```ts
// src/lib/auth/guards.ts
export async function requireUser(): Promise<SessionUser>  // throws ApiError(401)
export async function requireAdmin(): Promise<SessionUser>  // throws ApiError(403)
export async function getOptionalUser(): Promise<SessionUser | null>
```

The JWT payload carries `{ sub: userId, email, role, name }`. The role is re-verified against the database for admin routes, so a stale token cannot preserve admin rights after a role change. Admin reads are cheap (one indexed lookup) and the security benefit is real.

---

## 6. Step-by-step implementation guide

Each step is independently verifiable. Do not proceed until the current step's verification passes.

### Step 1 — Project scaffold

```bash
cd "C:\Users\BS01137\Downloads\Euro Glam BD"
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --no-turbopack
```

**Environment note:** Node v24.22.0, npm 11.19.1, npm-only (no pnpm/yarn/bun). Docker is **not** installed, but PostgreSQL 18 **is** at `C:\Program Files\PostgreSQL\18\` and is listening on 5432. Add `C:\Program Files\PostgreSQL\18\bin` to PATH to use `psql` from the shell.

`create-next-app` requires an empty directory except for a few allow-listed files. `PRD.md`, `SRS.md`, and `DECISIONS.md` are **not** on the allow-list and will cause it to refuse. Handle this:

```bash
# Option A — scaffold into a temp dir and move files in (recommended)
cd "C:\Users\BS01137\Downloads"
npx create-next-app@latest euro-glam-tmp --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --no-turbopack
# then move the generated contents into "Euro Glam BD"
```

**Verify:** `npm run dev` starts and `src/app/page.tsx` renders at `http://localhost:3000`.

### Step 2 — Dependencies

```bash
npm install @prisma/client zod jose
npm install -D prisma @types/node tsx
```

`jose` for JWT (pure ESM, works in the Edge and Node runtimes, no native deps). `zod` for validation. `tsx` to run the seed script (Prisma's seed runner needs a TS-capable runner).

**Verify:** `npm ls @prisma/client zod jose` lists all three at a version.

### Step 3 — Environment files

`.env` (git-ignored) and `.env.example` (committed).

```dotenv
# .env.example
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/euro_glam_bd?schema=public"

AUTH_JWT_SECRET="replace-with-at-least-32-random-bytes"
AUTH_JWT_TTL_SECONDS="604800"

AI_PROVIDER="mock"
OPENAI_API_KEY=""

STORAGE_DRIVER="local"
UPLOAD_ROOT="./public/uploads"
MAX_IMAGE_BYTES="5242880"
MAX_VIDEO_BYTES="52428800"

SMS_GATEWAY="mock"

DISCLAIMER_TEXT="This is an aesthetic/skincare suggestion, not a medical prescription from a doctor."
```

**Verify:** `node -e "require('dotenv').config(); console.log(process.env.DATABASE_URL)"` prints the URL. (If `dotenv` isn't installed, Next.js loads `.env` automatically in dev — that is sufficient for the app, and the seed script needs `dotenv` explicitly or `--env-file`.)

### Step 4 — Create the database

```bash
psql -U postgres -c "CREATE DATABASE euro_glam_bd;"
```

If `psql` is not on PATH, use the full path: `"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE euro_glam_bd;"`. You will be prompted for the `postgres` superuser password.

**Verify:** `psql -U postgres -l` lists `euro_glam_bd`.

### Step 5 — Prisma schema and migration

Write the full schema (existing PRD models + the five new ones from §2.1, with the §2.3 changes). Key requirements to get right:

- `generator client` with `provider = "prisma-client-js"`
- `datasource db` with `provider = "postgresql"` and `url = env("DATABASE_URL")`
- Do **not** set `relationMode` — keep the default `foreignKeys`
- Explicit `onDelete: Restrict` on all order/history relations
- `onDelete: Cascade` only for conversation sub-resources
- `onDelete: SetNull` only for `UserSkinProfile.profileImageId`
- `Jsonb` for `ingredients` and `AdvisorMessage.meta`
- `Int` poisha for all money fields

```bash
npx prisma migrate dev --name init
npx prisma generate
```

**Verify:**
- `npx prisma validate` passes.
- `npx prisma migrate status` reports the database is up to date.
- `npx prisma studio` opens and shows all tables. *(Optional — Prisma Studio is a dev dependency; the CLI bundles it.)*

**Uncertainty to resolve at this step:** the research flagged that `@@index` on a `String[]` field is undocumented. The schema must **not** place an index on `ingredientTags` or `aiProductIds`. If a future need arises, add a raw GIN index via a migration with `CREATE INDEX ... USING GIN (...)`.

### Step 6 — Prisma client singleton

```ts
// src/lib/db.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
```

The global caching pattern prevents exhausting the PostgreSQL connection pool during Next.js hot-reload in development — a real problem with the default pool size of 10.

**Verify:** `npx tsx -e "import {db} from './src/lib/db'; db.user.count().then(c => { console.log(c); process.exit(0) })"` prints `0`.

### Step 7 — Auth foundation

Files: `src/lib/auth/jwt.ts`, `session.ts`, `guards.ts`, plus `src/lib/api/respond.ts` and `src/lib/api/types.ts`.

- `jwt.ts` — `signToken(payload)` and `verifyToken(token)` using `jose` with `HS256` and `SecretKey` from `AUTH_JWT_SECRET`. Reject a secret shorter than 32 bytes at startup.
- `session.ts` — cookie named `egb_session`; `httpOnly: true`, `sameSite: "lax"`, `secure: process.env.NODE_ENV === "production"`, `path: "/"`, `maxAge: 604800`.
- `guards.ts` — read the cookie via `cookies()` from `next/headers`, verify, load the user from the database, and return the session user. Throw a typed `ApiError` on failure so route handlers have one error path.
- `respond.ts` — `ok(data)` and `fail(code, message, status)` returning the envelope from §4.0, plus `handleApiError(error)` that maps thrown `ApiError` to a response and logs anything else as `INTERNAL_ERROR` **without** leaking internals to the client.

**Verify:** write a throwaway script that signs a token, verifies it, and asserts a tampered token is rejected.

### Step 8 — Storage adapter + upload validation

Files: `src/lib/storage/adapter.ts`, `local-driver.ts`, `src/lib/upload/validate.ts`.

- `validate.ts` — `detectMimeType(buffer)` reads magic bytes for JPEG (`FF D8 FF`), PNG (`89 50 4E 47`), WebP (`RIFF....WEBP`). Expose `assertValidImage(bytes, declaredMime, maxBytes)`.
- `local-driver.ts` — `put()` generates the key, creates the directory, writes the file, returns `StoredObject`. `getUrl()` returns `/uploads/<key>`. `delete()` is a no-op-with-warning if the file is already absent (idempotent — cleanup jobs will call it repeatedly).
- Path safety: after resolving the final path, assert it starts with the resolved upload root plus a separator. This blocks traversal via a crafted key.

**Verify:** write a script that saves a 1x1 PNG, reads it back, confirms the URL, deletes it, and confirms the file is gone. Separately, assert that a `.txt` file renamed to `.png` is **rejected** by magic-byte validation — that is the test that proves the validation is real.

### Step 9 — Conflict engine + catalogue

Files: `src/lib/conflicts/catalogue.ts`, `rules.ts`, `engine.ts`.

- `catalogue.ts` — canonical ingredient IDs with display names and admin aliases. Seed with at least: `AHA`, `BHA`, `RETINOL`, `RETINYL_PALMITATE`, `VITAMIN_C`, `NIACINAMIDE`, `HYALURONIC_ACID`, `SALICYLIC_ACID`, `GLYCOLIC_ACID`, `LACTIC_ACID`, `BENZOYL_PEROXIDE`, `HYDROQUINONE`, `AHAs`.
- `rules.ts` — at minimum: `AHA + RETINOL → BLOCK`; `BHA + RETINOL → WARN`; `AHA + BHA → WARN`; `VITAMIN_C + VITAMIN_C → WARN`; `BENZOYL_PEROXIDE + AHAs → WARN`; `RETINOL + RETINOL → WARN`.
- `engine.ts` — `evaluateConflicts(products, rules)`. For each rule, check whether any two products in the set carry the two ingredient tags (or the same tag for a same-ingredient rule). Collect `involvedProductIds`. Sort `BLOCK` before `WARN`, then by `ruleId`.

**Verify:** write unit tests (`node:test` or Vitest) covering: no products → no conflicts; two products with a conflicting pair → one conflict; ordering is `BLOCK` first; the function is pure (same input, same output, twice). **These tests are the most valuable in the codebase** — the engine is the safety-critical part, and the tests prove the code path the LLM never touches.

### Step 10 — AI providers + service

Files: `src/lib/ai/provider.ts`, `mock-provider.ts`, `openai-provider.ts`, `service.ts`, `index.ts`.

- `mock-provider.ts` — deterministic. Hash the request to a seed; select from templates. Must emit recommendations only from `request.candidates` and must reflect the conflicts it was given.
- `openai-provider.ts` — build a system prompt that (a) injects the disclaimer text, (b) injects the candidate list with ids, (c) instructs the model to return product ids only from the list, (d) states the behavioural rules from §5.4. Send the image as a base64 data URL. Use `response_format: { type: "json_schema", ... }` with a strict schema of `{ content, recommendedProductIds }` — structured output is more reliable than parsing free text.
- `service.ts` — the orchestrator. Load profile, load cart products, load candidates, run the engine, filter `BLOCK` candidates, call the provider, then re-apply the code-decided conflicts (§5.5) and attach the disclaimer.

**Verify:** with `AI_PROVIDER=mock`, the service returns a response with no API key set and no network access. Call it twice with the same input and assert the output is byte-identical.

### Step 11 — API routes

Implement in this order, testing each:

1. `GET /api/advisor/config`
2. `GET|PUT /api/advisor/profile`
3. `GET /api/advisor/conversations`
4. `GET|DELETE /api/advisor/conversations/[id]`
5. `POST /api/admin/advisor/config`
6. `GET /api/admin/advisor/messages`
7. `POST /api/advisor/chat` (last — it depends on everything)

**`POST /api/advisor/chat` in detail:**

```ts
export const runtime = "nodejs";           // Buffer + fs + Prisma — not Edge
export const maxDuration = 30;              // real provider latency
```

Steps:
1. `requireUser()` → 401 if unauthenticated.
2. Parse `FormData`. Extract `message`, `image`, `conversationId`, `saveAsProfilePhoto`.
3. Zod-validate the text fields.
4. If an image is present: read as `ArrayBuffer` → `Buffer` → assert size → detect MIME via magic bytes → assert it is an allowed image type → `storage.put()`.
5. Resolve or create the conversation. If `conversationId` is supplied, verify ownership with a `where: { id, userId }` query — a missing record returns `404`, which avoids leaking whether another user's conversation exists.
6. **Transaction 1** — create the `AdvisorImage` (if any) and the `USER` message. Both are durable facts the user has already produced; they must be persisted even if the AI call later fails, otherwise the user loses their question on a provider error.
7. Load the skin profile, cart products, and candidate products. Build `ProductCandidate[]` for candidates that are in `AiConfig.aiProductIds` (or all, if that list is empty).
8. Run `evaluateConflicts` over candidates + cart products. Partition candidates into allowed and `BLOCK`ed.
9. Call the provider. Validate its output against the allowed set (§5.5).
10. **Transaction 2** — create the `ASSISTANT` message with `meta` (recommended ids, conflicts, `disclaimerVersion`, provider info), and upsert the `UserSkinProfile` (update `skinType`/`concerns` if the provider extracted them, set `lastAnalysisDate`).
11. Return the envelope.

**Transaction boundaries — why two and not one:** the AI provider call is slow and external. Holding a database transaction open across it would keep a connection checked out of the pool for the duration of the network call, and a provider timeout would roll back the user's question. Two transactions split the durable facts (user message) from the derived facts (assistant reply). If the provider fails, the user's message is still saved and the error response tells them to retry.

**Verify:** `curl` the endpoint with a session cookie and an image. Confirm two rows appear in `advisor_messages`, one `advisor_images` row, and that the response's `disclaimer.version` matches `AiConfig.disclaimerVersion`.

### Step 12 — Client UI

- `src/app/advisor/page.tsx` — the chat page. Server component that loads the profile, renders `<AdvisorChat>`.
- `src/app/advisor/components/AdvisorChat.tsx` — client component. Manages message state, handles the file picker, posts to `/api/advisor/chat` with `FormData`.
- `src/app/advisor/components/DisclaimerBanner.tsx` — the persistent, non-dismissible banner. Rendered above the message list, sourced from `/api/advisor/config`.
- `src/app/advisor/components/MessageBubble.tsx` — renders one message, its product recommendation cards, and any conflict warnings. The conflict warning is rendered from the code-decided conflicts, styled by severity (`BLOCK` = red, `WARN` = amber).
- `src/app/advisor/components/ProductRecommendationCard.tsx` — name, price, discount badge, "Add to Cart" action, and the reason string.

**State management:** plain React `useState` for the MVP. The message list is a simple array; there is no need for a server-state library yet. Add TanStack Query when a second page needs the same data.

**Disclaimer rendering:** the banner is rendered from config on mount, and the version in each assistant message's meta is used to detect drift — if a message was produced under an older disclaimer version, it is still shown, but the current banner is what is displayed.

**Verify:** upload an image and a question; see the assistant reply, product cards, the disclaimer banner, and the image in the message list. Refresh the page and confirm the history persists.

### Step 13 — Seed data

`prisma/seed.ts` — seed categories, ~20 products across skincare/makeup/baby care with realistic BDT prices in poisha, ingredient tags drawn from the catalogue, climate tips, reviews, one admin user, and a default `AiConfig` row with the disclaimer text.

Generate the password hash with `bcrypt`:

```ts
import bcrypt from "bcryptjs";
const hash = await bcrypt.hash("ChangeMe123!", 12);
```

**Use `bcryptjs`, not `bcrypt`** — the native `bcrypt` package needs a build toolchain on Windows and frequently fails to install. `bcryptjs` is pure JavaScript, has no native dependency, and is functionally equivalent for this purpose. This is a deliberate deviation from the SRS's "bcrypt" wording, made for install reliability.

**Verify:** `npx prisma db seed` completes without error, and `npx prisma studio` shows populated tables.

### Step 14 — Admin monitoring screens

Minimal but functional: a table of advisor messages with filters (provider, date range, conversation), a detail view showing the message meta (recommended products, conflicts, disclaimer version), and a form for editing `AiConfig`.

**Verify:** the admin list shows the messages created during Step 11's test, and editing the disclaimer text bumps `disclaimerVersion` and changes the banner for the next chat.

---

## 7. Security and validation summary

| Concern | Control |
|---|---|
| Session theft via XSS | JWT in an `httpOnly` cookie — unreadable by JavaScript |
| CSRF | `sameSite: "lax"` cookies + `POST` with a non-simple content type. For `multipart/form-data` specifically, add an `Origin` check on mutating routes. |
| Privilege escalation via a stale token | The role is re-read from the database on admin routes |
| Path traversal via filename | Filenames are regenerated; the resolved path is asserted to be inside the upload root |
| Malicious uploads | Magic-byte validation, size caps, dimension caps, generated filenames, no metadata trust |
| Prompt injection via a crafted review | The provider's output is validated against an allow-list; product ids outside the candidate set are dropped |
| LLM ignoring the disclaimer | The disclaimer is attached by the service layer after the provider returns, not requested from the provider |
| LLM overriding a safety rule | Code-decided conflicts are re-attached after the provider returns; the provider cannot downgrade a severity |
| Admin modifying the disclaimer | The admin route rejects an empty disclaimer; the service layer has a hardcoded fallback |
| Unauthorised access to a conversation | Every query is scoped by `userId`; a non-owned id returns `404` |
| Rate limiting on the AI endpoint | 20 messages/hour/user — essential, since each message is a paid API call in production |

---

## 8. Open items carried forward

These are **not** blocking this feature, but they must be resolved before the platform is called production-ready:

1. **The `local` storage driver requires a persistent filesystem.** Confirm the deployment target is a long-running Node server. If it moves to Vercel/Netlify, the driver must be swapped for Cloudinary or S3 — the adapter interface is designed for exactly this, but the deployment constraint is real.
2. **The image cleanup job is not in this spec.** A scheduled job purging expired `AdvisorImage` rows and their files is required once retention is enforced. Tracked under the SMS job's future scheduler.
3. **Real OpenAI costs need a budget.** The rate limit (20/hour/user) is a starting point, not a cost control. Add a per-user daily cap before enabling the real provider in a public demo.
4. **Bangla localisation is not covered.** The rules' `message` and `remedy` strings are English. A Bangla variant is a data change, not a code change — the fields are already structured for it.
5. **Moderation of advisor messages.** PRD §4 says the admin should "monitor chatbot recommendations". This spec provides the visibility. An explicit approve/reject workflow for advisor messages is not included and may not be needed, since the AI's output is deterministic and rule-governed.
6. **The `openai-provider` structured-output contract has not been verified against a live API.** Test it with a real key before relying on it.
