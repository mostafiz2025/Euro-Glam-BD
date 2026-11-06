/**
 * Frontend types.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **These types mirror the API contracts exactly. They are not a second
 * opinion about what the API returns.**
 *
 * Every shape here is copied from the service that produces it —
 * `ProductSummary` and `ProductDetail` from
 * `src/lib/catalog/service.ts`, `CartView` from
 * `src/lib/cart/service.ts`, and the envelope from
 * `src/lib/api/types.ts`. When the API changes, these change with it.
 *
 * Why duplicate them at all, rather than importing the service types?
 * Two reasons:
 *
 *   1. The service modules import Prisma. A `"use client"` component
 *      cannot import a module that reaches the database — it would pull
 *      the Prisma engine into the browser bundle. The frontend needs the
 *      *shape* without the *dependency*.
 *
 *   2. A frontend type is a contract with the server. Declaring it
 *      separately makes the contract explicit and lets the two drift
 *      visibly — a changed field becomes a type error rather than a
 *      runtime `undefined`.
 *
 * The duplication is deliberate, and it is the only one in the codebase.
 */

/**
 * The API response envelope.
 *
 * Mirrors `ApiSuccess` / `ApiFailure` from `src/lib/api/types.ts`.
 */
export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };

/**
 * A category, as the catalogue API returns it.
 *
 * Mirrors `CategorySummary` from `src/lib/catalog/service.ts`.
 */
export type CategorySummary = {
  id: string;
  name: string;
  slug: string;
  /**
   * The card image's **storage key**, or `null`.
   *
   * A key, not a URL — the driver can be swapped for a bucket without
   * rewriting every row. `imageUrl()` turns it into a URL at render
   * time.
   */
  image: string | null;
  productCount: number;
};

/**
 * A skin concern, as the catalogue API returns it.
 *
 * Mirrors `ConcernSummary` from `src/lib/catalog/service.ts`.
 */
export type ConcernSummary = {
  id: string;
  name: string;
  slug: string;
  /** The ingredient tag the concern filter uses — "BHA". */
  tag: string;
  /** The other tags in this family, offered in the filter panel. */
  relatedTags: string[];
  /** The card image's storage key, or `null`. */
  image: string | null;
  description: string | null;
};

/**
 * A brand, as the catalogue API returns it.
 *
 * Mirrors `BrandSummary` from `src/lib/catalog/service.ts`.
 */
export type BrandSummary = {
  id: string;
  name: string;
  slug: string;
  /** The two-letter monogram shown when no logo is uploaded. */
  monogram: string;
  /** The logo's storage key, or `null`. */
  logo: string | null;
  description: string | null;
  /** How many **sellable** products carry this brand. */
  productCount: number;
};

/**
 * A product summary, as the catalogue API returns it.
 *
 * Mirrors `ProductSummary` from `src/lib/catalog/service.ts`.
 */
export type ProductSummary = {
  id: string;
  name: string;
  description: string;
  /**
   * The product's brand, or `null` when it is unknown.
   *
   * The storefront renders no brand line at all for a `null` brand.
   */
  brand: string | null;
  pricePaisa: number;
  discountPricePaisa: number | null;
  discountPercentage: number | null;
  /** The price the customer actually pays. */
  effectivePricePaisa: number;
  stockQuantity: number;
  inStock: boolean;
  ingredientTags: string[];
  /**
   * The skin concerns the product is tagged with — "acne", "dryness".
   *
   * The slugs, not the names. A slug survives a rename; an id would
   * not, and a name would be presentation.
   */
  concernSlugs: string[];
  climateTips: string | null;
  /** Storage adapter keys, not raw URLs. */
  images: string[];
  isNewArrival: boolean;
  isBestSeller: boolean;
  category: { id: string; name: string; slug: string };
};

/**
 * A product detail, as the catalogue API returns it.
 *
 * Mirrors `ProductDetail` from `src/lib/catalog/service.ts`.
 */
export type ProductDetail = ProductSummary & {
  /**
   * The raw ingredients JSON.
   *
   * The column is untyped (`Jsonb`), so the shape is only known at
   * runtime. `parseIngredients` in
   * `src/lib/format/ingredients.ts` narrows it safely.
   */
  ingredients: unknown;
  rating: { average: number; count: number };
  relatedProductIds: string[];
};

/**
 * A homepage hero banner, as the storefront's carousel sees it.
 *
 * Mirrors `AdminHeroBanner` from `src/lib/admin/hero-banners.ts`, minus
 * the fields that are admin-only: `isActive` (a banner that is switched
 * off is not returned at all), `sortOrder` (the order is already applied
 * by the time the list arrives) and the timestamps.
 *
 * The `image` is a **storage key**, not a URL — `imageUrl()` turns it
 * into a URL at render time.
 */
export type HeroBannerSummary = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
  secondaryCtaLabel: string;
  secondaryCtaHref: string;
  trust: string[];
  /** The banner's background artwork — a storage key, or `null`. */
  image: string | null;
  /** The gradient wash, as a Tailwind class string. */
  gradient: string;
  /** The accent colour for the slide's decorative glow. */
  glow: string;
};

/**
 * The pagination block every list endpoint returns.
 */
export type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

/**
 * The result of a product list query.
 *
 * Mirrors `ProductListResult` from `src/lib/catalog/service.ts`.
 */
export type ProductListResult = {
  products: ProductSummary[];
  pagination: Pagination;
  appliedFilters: {
    search?: string;
    category?: string;
    ingredient?: string;
    /** The skin concern slug the catalogue filtered on. */
    concern?: string;
    isNewArrival?: boolean;
    isBestSeller?: boolean;
    inStock?: boolean;
    minPricePaisa?: number;
    maxPricePaisa?: number;
    sort: string;
  };
};

/**
 * An ingredient conflict, as the cart API returns it.
 *
 * Mirrors `CartConflictSummary` from `src/lib/cart/service.ts`.
 */
export type CartConflictSummary = {
  ruleId: string;
  severity: "BLOCK" | "WARN";
  title: string;
  message: string;
  remedy: string;
  spacingAdvice: string;
  involvedProductIds: string[];
  ingredientIds: string[];
};

/**
 * A cart line, as the cart API returns it.
 *
 * Mirrors `CartLine` from `src/lib/cart/service.ts`.
 */
export type CartLine = {
  id: string;
  productId: string;
  quantity: number;
  product: {
    id: string;
    name: string;
    pricePaisa: number;
    discountPricePaisa: number | null;
    stockQuantity: number;
    ingredientTags: string[];
    climateTips: string | null;
    images: string[];
    category: { id: string; name: string; slug: string };
  };
  unitPricePaisa: number;
  lineTotalPaisa: number;
  exceedsStock: boolean;
};

/**
 * A discount code, as the shop floor shows it.
 *
 * Mirrors `PublicCoupon` from `src/lib/coupons/rules`.
 */
export type PublicCoupon = {
  /** The uppercase code the customer types. */
  code: string;
  /** The admin's description, shown as the offer's wording. */
  description: string | null;
  /** "20% off" or "৳200 off" — how the offer is described. */
  label: string;
  /** The expiry, as an ISO timestamp. */
  expiresAt: string;
};

/**
 * A discount code applied to a particular cart.
 *
 * Mirrors `AppliedCoupon` from `src/lib/coupons/rules`.
 */
export type AppliedCoupon = {
  /** The uppercase code. */
  code: string;
  /** The admin's description. */
  description: string | null;
  /** How the offer is described — "20% off". */
  label: string;
  /** What it takes off, in poisha. */
  discountPaisa: number;
  /** The subtotal it was applied to, in poisha. */
  subtotalPaisa: number;
};

/**
 * The full cart, as the cart API returns it.
 *
 * Mirrors `CartView` from `src/lib/cart/service.ts`.
 */
export type CartView = {
  id: string;
  items: CartLine[];
  subtotalPaisa: number;
  totalQuantity: number;
  conflicts: CartConflictSummary[];
  /**
   * The discount code applied to this cart, or `null`.
   *
   * `null` means "no coupon" — and it is also what a code that has
   * become unusable since it was applied resolves to.
   */
  coupon: AppliedCoupon | null;
};

/**
 * The result of adding an item to the cart.
 *
 * Mirrors `AddToCartResult` from `src/lib/cart/service.ts`.
 */
export type AddToCartResult = {
  cart: CartView;
  newConflicts: CartConflictSummary[];
  hasBlockingConflict: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// The AI Advisor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A product the advisor recommended.
 *
 * Mirrors `Recommendation` from `src/lib/ai/service.ts`.
 *
 * The `reason` is composed **in code**, not written by the model — see
 * the service layer's "code decides, the model phrases" rule.
 */
export type AdvisorRecommendation = {
  productId: string;
  name: string;
  pricePaisa: number;
  discountPricePaisa: number | null;
  reason: string;
};

/**
 * An ingredient conflict the advisor surfaced.
 *
 * Mirrors `AdvisorConflict` from `src/lib/ai/service.ts`.
 *
 * The severity and the involved products are decided by the conflict
 * engine, never by the model.
 */
export type AdvisorConflict = {
  ruleId: string;
  severity: "BLOCK" | "WARN";
  title: string;
  message: string;
  remedy: string;
  spacingAdvice: string;
  involvedProductIds: string[];
  ingredientIds: string[];
};

/**
 * The skin profile snapshot the advisor worked from.
 *
 * Mirrors the `skinProfile` field of `AdvisorResult`.
 */
export type AdvisorSkinProfile = {
  skinType: string | null;
  concerns: string[];
};

/**
 * The disclaimer shown with an advisor response.
 *
 * Mirrors `Disclaimer` from `src/lib/ai/disclaimer.ts`.
 */
export type AdvisorDisclaimer = {
  text: string;
  version: number;
};

/**
 * Which provider produced a response.
 *
 * Mirrors the `provider` field of `AdvisorResult`.
 */
export type AdvisorProvider = {
  name: string;
  isMocked: boolean;
  /**
   * The model that produced the answer, e.g. `gemini-2.5-flash`.
   *
   * Distinct from `name`, which is the *provider* — `gemini`, `openai`,
   * `mock`. The two are recorded separately because the audit trail
   * needs both: "who billed us" and "which model wrote this" are
   * different questions.
   */
  model: string;
};

/**
 * What code decided a chat turn was.
 *
 * Mirrors the `intent` field of `AdvisorResult`.
 *
 * `mayRecommend` is the flag the whole conversational behaviour hangs
 * off: a greeting turn has it `false`, and the service layer drops any
 * product the model tried to attach to it.
 *
 * `mayWarn` is the same kind of flag for the ingredient-conflict
 * warnings: `false` on a greeting, an order question, and a question
 * that is not about combining products — so the customer is not shown a
 * "Use with care" card about a routine they did not ask about.
 */
export type AdvisorIntent = {
  kind: "GREETING" | "CONCERN" | "QUESTION" | "ORDER";
  mayRecommend: boolean;
  mayWarn: boolean;
  missing: Array<"SKIN_TYPE" | "CONCERNS">;
};

/**
 * The result of a chat turn.
 *
 * Mirrors `AdvisorResult` from `src/lib/ai/service.ts`.
 */
export type AdvisorChatResult = {
  conversationId: string;
  message: {
    id: string;
    role: "ASSISTANT";
    content: string;
    createdAt: string;
  };
  recommendations: AdvisorRecommendation[];
  conflicts: AdvisorConflict[];
  skinProfile: AdvisorSkinProfile;
  disclaimer: AdvisorDisclaimer;
  provider: AdvisorProvider;
  intent: AdvisorIntent;
};

/**
 * A conversation summary.
 *
 * Mirrors `ConversationSummary` from `src/lib/ai/conversations.ts`.
 */
export type AdvisorConversationSummary = {
  id: string;
  title: string | null;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
};

/**
 * One message in a conversation.
 *
 * Mirrors `ConversationMessage` from `src/lib/ai/conversations.ts`.
 */
export type AdvisorConversationMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt: string;
  provider: string | null;
  model: string | null;
  isMocked: boolean;
  meta: unknown;
  images: ReadonlyArray<{
    id: string;
    url: string;
    mimeType: string;
  }>;
};

/**
 * A conversation with its full history.
 *
 * Mirrors `ConversationDetail` from `src/lib/ai/conversations.ts`.
 */
export type AdvisorConversationDetail = AdvisorConversationSummary & {
  messages: readonly AdvisorConversationMessage[];
};

/**
 * The skin profile.
 *
 * Mirrors the `profile` payload of `GET /api/advisor/profile`.
 */
export type AdvisorProfile = {
  id: string | null;
  skinType: string | null;
  concerns: string[];
  notes: string | null;
  estimatedEmptyAt: string | null;
  smsOptIn: boolean;
  profileImageId: string | null;
  /** True when the customer has never saved a profile. */
  isEmpty: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// The admin notification inbox
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kinds of admin notification.
 *
 * Mirrors the `AdminNotificationKind` enum.
 */
export type AdminNotificationKind =
  | "ORDER_PLACED"
  | "PAYMENT_SETTLED"
  | "PAYMENT_FAILED";

/**
 * One admin notification, as the bell holds it.
 *
 * Mirrors `AdminNotificationView` from `src/lib/admin/notifications.ts`.
 *
 * The service returns `createdAt` as a `Date`, which does not survive
 * `JSON.stringify` as a `Date` — it becomes an ISO string. So the
 * frontend contract says `string`, and the browser parses it. This is
 * the one place the two shapes differ, and it differs on purpose: the
 * wire format is JSON, and a `Date` on the wire is a string.
 */
export type AdminNotification = {
  id: string;
  kind: AdminNotificationKind;
  orderId: string;
  orderNumber: string;
  customerName: string;
  totalAmountPaisa: number;
  paymentMethod: "COD" | "BKASH" | "NAGAD" | "CARD";
  read: boolean;
  /** The ISO timestamp the service sent. */
  createdAt: string;
};

/**
 * The payload of `GET /api/admin/notifications`.
 *
 * Both halves come from the server in one response, so the badge count
 * and the list can never disagree.
 */
export type AdminNotificationInbox = {
  notifications: AdminNotification[];
  unreadCount: number;
};

