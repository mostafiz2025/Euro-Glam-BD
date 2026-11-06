import { z } from "zod";

import { DISCOUNT_BADGE, canonicalBadge } from "@/lib/format/badges";
import {
  MAX_BRAND_LENGTH,
  canonicalBrand,
} from "@/lib/format/brand";
import { legacyPathToStorageKey } from "@/lib/format/image";

import { entityIdSchema } from "./commerce";

/**
 * Validation schemas for the admin API.
 *
 * ── Why a separate file ────────────────────────────────────────────────
 *
 * `src/lib/validation/commerce.ts` is the **customer-facing** vocabulary:
 * what a shopper may send. This file is the **admin-facing** vocabulary:
 * what a member of staff may send.
 *
 * The two are kept apart on purpose. Mixing them would blur the most
 * important boundary in the system — the difference between what a
 * customer can do and what an admin can do — and it would make it far
 * easier to accidentally reuse a permissive customer schema on an admin
 * route.
 *
 * The rules are the same as everywhere else in the codebase:
 *
 *   1. **Invalid input is rejected, never silently ignored.** A filter
 *      the server does not recognise is an error, not a default. If the
 *      client asks for `status=shipped` and gets `PENDING` back with a
 *      200, nobody can work out why.
 *   2. **Query strings are strings.** `page=3` arrives as `"3"`, so the
 *      numeric fields coerce explicitly.
 *   3. **Free text is bounded.** A reason field is a sentence, not a
 *      document.
 */

/**
 * The maximum number of rows an admin list endpoint returns at once.
 */
const MAX_PAGE_SIZE = 100;

/**
 * The kinds of thing an audit entry can describe.
 *
 * These are the `entityType` values. They are a closed set, because an
 * entry whose type is not one of these is a bug — it would be invisible
 * to every filter.
 *
 * The list lives here, in the **validation** layer, rather than beside
 * the audit writer, because the admin services import from this file and
 * this file must not import from them. The audit writer takes the list
 * from here, so there is exactly one copy — a second list is a list
 * that will drift.
 */
export const AUDIT_ENTITY_TYPES = [
  "review",
  "order",
  "order_item",
  "product",
  "ai_config",
  "coupon",
  "category",
  "concern",
  "brand",
  "hero_banner",
  "site_settings",
  "admin_profile",
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * A pagination block, shared by every admin list endpoint.
 */
const paginationShape = {
  page: z.coerce
    .number()
    .int("The page number must be a whole number.")
    .min(1, "The page number must be at least 1.")
    .default(1),
  limit: z.coerce
    .number()
    .int("The page size must be a whole number.")
    .min(1, "The page size must be at least 1.")
    .max(MAX_PAGE_SIZE, "That page size is too large.")
    .default(20),
};

/**
 * The moderation state of a review.
 *
 * `PENDING` — awaiting moderation.
 * `APPROVED` — published.
 * `HIDDEN` — was published, now withdrawn.
 * `ALL` — every review, regardless of state.
 */
export const reviewStatusFilterSchema = z.enum([
  "PENDING",
  "APPROVED",
  "HIDDEN",
  "ALL",
]);

export type ReviewStatusFilter = z.infer<typeof reviewStatusFilterSchema>;

/**
 * The action a moderator takes on a review.
 */
export const reviewActionSchema = z.enum(["APPROVE", "HIDE", "UNHIDE"]);

export type ReviewAction = z.infer<typeof reviewActionSchema>;

/**
 * A moderation reason, shared by every admin mutation that accepts one.
 */
const reasonSchema = z
  .string()
  .trim()
  .max(500, "That reason is too long.")
  .optional();

/**
 * The body of a review moderation request.
 */
export const reviewModerationSchema = z.object({
  action: reviewActionSchema,
  reason: reasonSchema,
});

export type ReviewModerationInput = z.infer<typeof reviewModerationSchema>;

/**
 * The query for the review moderation queue.
 */
export const adminReviewQuerySchema = z.object({
  status: reviewStatusFilterSchema.default("PENDING"),
  productId: entityIdSchema.optional(),
  userId: entityIdSchema.optional(),
  ...paginationShape,
});

export type AdminReviewQuery = z.infer<typeof adminReviewQuerySchema>;

/**
 * The fulfilment statuses an admin may set.
 *
 * `PENDING` is absent because an order is created as `PENDING` and an
 * admin never moves an order *back* to it — the transition table in
 * `src/lib/admin/orders.ts` is forward-only.
 */
export const orderStatusTargetSchema = z.enum([
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
]);

export type OrderStatusTarget = z.infer<typeof orderStatusTargetSchema>;

/**
 * The body of an order status update.
 */
export const orderStatusUpdateSchema = z.object({
  status: orderStatusTargetSchema,
  reason: reasonSchema,
});

export type OrderStatusUpdateInput = z.infer<typeof orderStatusUpdateSchema>;

/**
 * The payment statuses an admin may set.
 *
 * `PENDING` is absent for the same reason as above: the money has not
 * moved yet, and an admin marking an order `PAID` before the courier
 * collects the cash would be recording something untrue.
 */
export const paymentStatusTargetSchema = z.enum([
  "PAID",
  "FAILED",
  "REFUNDED",
]);

export type PaymentStatusTarget = z.infer<typeof paymentStatusTargetSchema>;

/**
 * The body of a payment status update.
 */
export const paymentStatusUpdateSchema = z.object({
  paymentStatus: paymentStatusTargetSchema,
  reason: reasonSchema,
});

export type PaymentStatusUpdateInput = z.infer<
  typeof paymentStatusUpdateSchema
>;

/**
 * The query for the admin order list.
 */
export const adminOrderQuerySchema = z.object({
  status: z
    .enum(["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"])
    .optional(),
  paymentStatus: z
    .enum(["PENDING", "PAID", "FAILED", "REFUNDED"])
    .optional(),
  /**
   * The payment method the order was paid with.
   *
   * The four values are the shop's `PaymentMethod` enum, written out
   * here rather than imported: the validation module is the boundary,
   * and it should not depend on the Prisma client to describe the
   * values a **browser** is allowed to send.
   *
   * This is the filter the fulfilment desk needed most — "which bKash
   * transfers have not been confirmed yet" is the question a shop with
   * a mobile-banking rail asks every morning, and it was previously
   * unanswerable without opening the database.
   */
  paymentMethod: z.enum(["COD", "BKASH", "NAGAD", "CARD"]).optional(),
  /**
   * The sort order.
   *
   * A closed set, so an unrecognised order is an error rather than a
   * silent fallback — the same rule every other filter follows.
   *
   * `newest` is the default and is not even sent by the client: the
   * list is newest-first unless the admin asks otherwise, which is what
   * an operator watching a live desk wants.
   */
  sort: z
    .enum(["newest", "oldest", "highest", "lowest"])
    .optional(),
  userId: entityIdSchema.optional(),
  /**
   * A free-text search over the order number and the customer's name.
   *
   * Bounded, and trimmed — an unbounded search term is a database
   * round-trip waiting to be expensive.
   */
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminOrderQuery = z.infer<typeof adminOrderQuerySchema>;

/**
 * The body of a reminder sweep request.
 */
export const triggerRemindersSchema = z.object({
  /**
   * When true, the sweep reports what it would do without sending
   * anything or changing any row.
   */
  dryRun: z.boolean().default(false),
});

export type TriggerRemindersInput = z.infer<typeof triggerRemindersSchema>;

/**
 * The body of a manual resend request.
 */
export const resendSchema = z.object({
  orderItemId: entityIdSchema,
  reason: reasonSchema,
});

export type ResendInput = z.infer<typeof resendSchema>;

/**
 * The query for the admin SMS log.
 */
export const smsLogQuerySchema = z.object({
  userId: entityIdSchema.optional(),
  status: z.enum(["sent", "failed", "queued"]).optional(),
  orderItemId: entityIdSchema.optional(),
  ...paginationShape,
});

export type SmsLogQuery = z.infer<typeof smsLogQuerySchema>;

/**
 * The stock filter for the inventory list.
 *
 * `ARCHIVED` is a **visibility** band rather than a stock band — a
 * withdrawn product may still have units on the shelf. It is reported
 * separately so an admin can find and restore a product, and so the
 * live catalogue never silently hides rows.
 */
export const productStockFilterSchema = z.enum([
  "ALL",
  "IN_STOCK",
  "OUT_OF_STOCK",
  "LOW_STOCK",
  "ARCHIVED",
]);

export type ProductStockFilter = z.infer<typeof productStockFilterSchema>;

/**
 * The query for the admin inventory list.
 */
export const adminProductQuerySchema = z.object({
  stock: productStockFilterSchema.default("ALL"),
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminProductQuery = z.infer<typeof adminProductQuerySchema>;

/**
 * The body of a stock adjustment.
 *
 * The adjustment is a **signed delta**, not an absolute quantity. An
 * absolute "set to N" would silently clobber a concurrent checkout's
 * reservation; a delta cannot.
 */
export const stockAdjustmentSchema = z.object({
  delta: z
    .number()
    .int("The adjustment must be a whole number of units.")
    .min(-10_000, "That adjustment is too large.")
    .max(10_000, "That adjustment is too large.")
    .refine((value) => value !== 0, "The adjustment must change something."),
  reason: reasonSchema,
});

export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

/**
 * Whether a reference is an **absolute filesystem path** rather than a
 * storage key or a URL.
 *
 * Two shapes count:
 *
 *   • A POSIX path — `/srv/app/public/uploads/products/serum.jpg`
 *   • A Windows path — `C:\Users\…\public\uploads\products\serum.jpg`
 *
 * The Windows form is recognised by its **drive letter** (`X:`) or by
 * its **backslash separators**, not by the leading slash — a Windows
 * path has none.
 *
 * This matters because a Windows absolute path contains no `/`
 * separators at all, so the relative-key check below would see a single
 * innocuous-looking segment and wave it through. It must be checked
 * first.
 */
function looksLikeAbsoluteFilesystemPath(value: string): boolean {
  if (value.includes("\\")) return true;
  if (value.startsWith("/")) return true;

  // A drive letter: `C:` at the very start.
  return /^[A-Za-z]:/.test(value);
}

/**
 * One entry in a product's image list.
 *
 * ── Why this is a storage KEY, not a URL ──────────────────────────────────
 *
 * The Prisma schema says it plainly:
 *
 * > `/// Storage adapter keys — NOT raw URLs, so the driver can be swapped.`
 *
 * A key looks like `products/2026/10/9f2c1a7b….png`. The public URL is
 * derived at render time by `imageUrl()` in `src/lib/format/image.ts`,
 * which joins the key onto the `/uploads` prefix. Storing the URL instead
 * would mean rewriting every row when the driver moves to a bucket.
 *
 * So a **`.url()` check here was wrong** — it would have rejected every
 * key the upload pipeline produces, and accepted a hand-pasted URL that
 * the driver could not delete or serve.
 *
 * ### The legacy absolute URL is still accepted
 *
 * Rows written before the upload pipeline existed hold absolute URLs, and
 * `imageUrl()` passes them through untouched. Rejecting them here would
 * make those products unsaveable — an admin opening one to fix a typo
 * would get a 400 and no way to save. So an absolute URL is still valid
 * input; it simply is not what the uploader produces.
 *
 * ### The legacy absolute PATH is normalised, not refused
 *
 * The seeded catalogue is worse than that: thirteen of its rows hold the
 * **absolute filesystem path** of the image, written by whatever script
 * placed the files there:
 *
 * ```
 * C:\Users\someone\Downloads\Euro Glam BD\public\uploads\products\serum.jpg
 * ```
 *
 * That path is not a key, and joining it onto `/uploads` produced a URL
 * that resolved to nothing — so those products showed their
 * typographic placeholder while the image sat on disk the whole time.
 *
 * So it is **rewritten** to the key it was pointing at. The file has
 * not moved; only the reference is corrected. And because the rewrite
 * happens here, the act of saving a legacy product *repairs* it — which
 * is how the seeded rows get fixed, one admin save at a time, with no
 * migration script and no risk of touching a row by mistake.
 *
 * ### What is refused
 *
 * A key that tries to escape the upload root (`../`), a null byte, or
 * an empty string. Those are not legitimate keys under any reading, and
 * a key that escapes the root is a path-traversal attempt rather than a
 * typo.
 *
 * An absolute filesystem path that does **not** point into our uploads
 * root — `C:\Windows\System32\config.png` — is refused as well. It is
 * not one of ours, so rewriting it would be a guess, and storing it
 * would produce a URL that resolves to nothing.
 */
const productImageEntrySchema = z
  .string()
  .trim()
  .min(1, "An image reference cannot be empty.")
  .max(255, "That image reference is too long.")
  .refine(
    (value) => !value.includes("\0"),
    "That image reference contains an invalid character.",
  )
  .refine(
    (value) => {
      // An absolute URL is passed through untouched.
      if (
        value.startsWith("http://") ||
        value.startsWith("https://") ||
        value.startsWith("//")
      ) {
        return true;
      }

      // A legacy absolute filesystem path is handled by the transform
      // below — but only if it points into **our** uploads root. A path
      // that does not is not ours to rewrite, and guessing at it would
      // be worse than refusing it.
      if (looksLikeAbsoluteFilesystemPath(value)) {
        return legacyPathToStorageKey(value) !== null;
      }

      // A relative key: no parent-directory segment, and no leading
      // slash (the key is relative to the upload root, and a leading
      // slash would make it look absolute).
      const segments = value.split("/");

      return (
        !value.startsWith("/") &&
        segments.every((segment) => segment.length > 0 && segment !== "..")
      );
    },
    "That image reference points outside the upload directory.",
  )
  .transform((value) => {
    // An absolute URL is already a URL — leave it alone.
    if (
      value.startsWith("http://") ||
      value.startsWith("https://") ||
      value.startsWith("//")
    ) {
      return value;
    }

    // A legacy absolute filesystem path becomes the key it points at.
    return legacyPathToStorageKey(value) ?? value;
  });

/**
 * The maximum number of images a product may carry.
 *
 * ── Why the constant lives HERE ───────────────────────────────────────────
 *
 * The cap is enforced in three places — this schema (the list the
 * server will accept), the upload service (the batch the server will
 * store), and the picker (the number the form offers). When the same
 * number is written out three times, the three copies drift: the form
 * offers twenty-one images, the upload service accepts them, and the
 * schema refuses the product — and the admin is told the save failed
 * validation with no field named.
 *
 * This module is the **lowest** layer of the three (the validation
 * layer does not import from the admin services, and the services must
 * not depend on the validation layer's internals), so the constant is
 * **defined** here and the other two **import** it.
 */
export const MAX_PRODUCT_IMAGES = 20;

/**
 * A product's image list.
 *
 * The cap is `MAX_PRODUCT_IMAGES` — the same cap the form and the
 * upload service enforce, so a form can never produce a list the
 * server will refuse.
 *
 * ### `null` is accepted
 *
 * "No images" is an ordinary state, and a client that means it may say
 * it in either of the two ways a JSON body can express absence:
 * `null` or an omitted field. Both are accepted, so a client cannot
 * send a body the server refuses for a reason that has nothing to do
 * with what the admin did.
 *
 * This is the same `.nullable()` treatment `climateTips` and
 * `discountPricePaisa` get, and for the same reason: the Prisma
 * column is `String[]` with a default of an empty list, and the
 * service reads `input.images` as a list. A body that says `null`
 * means the same thing as a body that says `[]`.
 */
const productImagesSchema = z
  .array(productImageEntrySchema)
  .max(
    MAX_PRODUCT_IMAGES,
    `A product can carry at most ${MAX_PRODUCT_IMAGES} images.`,
  )
  .nullable()
  .transform((value) => value ?? []);

/**
 * A product's brand.
 *
 * ── The rules ───────────────────────────────────────────────────────────
 *
 * **1. It is optional.** A product can genuinely have no brand — a
 * shop's own generic line, an unbranded piece. `null` means "unknown",
 * and the storefront renders no brand line at all rather than a blank
 * one.
 *
 * **2. It is bounded.** 80 characters is more than "La Roche-Posay" and
 * more than any brand a shop would reasonably stock. A brand name is a
 * label, not a sentence.
 *
 * **3. A known brand is folded to its canonical spelling.** "cerave" and
 * "CeraVe" are one brand. Without this the shop could end up with three
 * products branded "cerave", "CeraVe" and "CERAVE", and the storefront
 * would show all three as different brands.
 *
 * **4. A custom brand is allowed.** The vocabulary is a closed list plus
 * a typed escape hatch — a shop that stocks a brand this code has never
 * heard of must have somewhere to put it. The custom brand is trimmed
 * and its whitespace collapsed, so it has the same shape as a
 * registered one.
 */
const productBrandSchema = z
  .string()
  .trim()
  .min(1, "A brand cannot be empty.")
  .max(MAX_BRAND_LENGTH, "That brand name is too long.")
  .transform((value) => canonicalBrand(value) ?? value);

/**
 * The maximum number of badges a product may carry.
 *
 * The known badges are four, and the custom tags are the shop's own
 * campaign labels. A dozen is plenty for a product card; a product with
 * twenty badges has a badge problem, not a promotional one.
 */
export const MAX_PRODUCT_BADGES = 12;

/**
 * The maximum length of a single badge.
 *
 * A badge is a label, not a sentence. 40 characters is more than
 * "Limited Edition" and more than any campaign name a shop would
 * reasonably want on a product card.
 */
const MAX_BADGE_LENGTH = 40;

/**
 * One badge on a product.
 *
 * ── The rules ───────────────────────────────────────────────────────────
 *
 * **1. A known badge is normalised to its canonical form.**
 *
 * "best seller" and "Best Seller" are the same badge, and storing both
 * spellings would render it twice. So a known badge is folded to the
 * exact entry from `KNOWN_BADGES` on the way in.
 *
 * **2. A custom tag is trimmed and bounded.**
 *
 * A custom tag may be anything, but not anything enormous — it is
 * rendered on a product card.
 *
 * **3. "Discount Offer" may not be stored.**
 *
 * Whether a product is discounted is a fact about its two prices, and
 * prices change. A stored "Discount Offer" badge on a product whose
 * discount was removed yesterday is a lie the storefront would tell. The
 * badge is **derived** from the prices at render time, so it is refused
 * here — and the client cannot store a badge the server would have to
 * second-guess.
 */
const productBadgeSchema = z
  .string()
  .trim()
  .min(1, "A badge cannot be empty.")
  .max(MAX_BADGE_LENGTH, "That badge is too long.")
  .refine(
    (value) => value !== DISCOUNT_BADGE,
    "The discount badge is set automatically from the prices.",
  )
  .transform((value) => canonicalBadge(value) ?? value);

/**
 * A product's badge list.
 *
 * ── Why duplicates are refused rather than merged ────────────────────────
 *
 * The schema **transforms** each entry (a known badge is folded to its
 * canonical form) and then checks the list for duplicates. Two entries
 * that normalise to the same badge are the same badge, and a list with
 * the same badge twice would render it twice.
 *
 * The check is on the **normalised** list, not the raw one — so
 * `["best seller", "Best Seller"]` is caught even though the two
 * strings differ.
 */
const productBadgesSchema = z
  .array(productBadgeSchema)
  .max(
    MAX_PRODUCT_BADGES,
    `A product can carry at most ${MAX_PRODUCT_BADGES} badges.`,
  )
  .refine(
    (badges) => new Set(badges).size === badges.length,
    "The same badge cannot appear twice.",
  );

/**
 * The promotional badges a product carries.
 *
 * ── Why the two legacy booleans are still accepted ──────────────────────
 *
 * `isNewArrival` and `isBestSeller` are read by the storefront, and the
 * admin form used to send them. They remain accepted on the create
 * body so an older client keeps working — but the **badge list is the
 * source of truth**, and the service derives the booleans from it.
 *
 * A client that sends both is not in conflict: the service merges them,
 * so a badge list saying "New Arrival" and a boolean saying `false`
 * still produce a product the storefront renders as new. The badge list
 * wins, because it is the more specific statement.
 */
export type ProductBadgeInput = z.infer<typeof productBadgesSchema>;

/**
 * The maximum number of skin concerns a product may carry.
 *
 * A concern is a shoppable axis — "Shop by Concern" — so a product that
 * claimed six of them would be findable under almost every browse. Four
 * is enough to say "this is an acne product that is also for dullness and
 * sensitivity" without turning the concern pages into a dumping ground.
 */
export const MAX_PRODUCT_CONCERNS = 4;

/**
 * The maximum length of a single concern slug.
 *
 * A slug is a URL segment — "fine-lines" — and the shop's own slugs are
 * short. 100 characters matches the `SkinConcern.slug` column, so the
 * two cannot disagree about how long a slug may be.
 */
const MAX_CONCERN_SLUG_LENGTH = 100;

/**
 * One skin concern slug on a product.
 *
 * ── Why a **slug** and not an id ───────────────────────────────────────────
 *
 * The product stores the concern's **slug** — "acne", "fine-lines" — and
 * not the concern's id.
 *
 * A slug is the shop's own stable, readable name for a concern, and it
 * is what the storefront's URLs already speak. Storing ids instead would
 * mean the column could not be read without a join, and every reader of
 * the product row would have to perform it.
 *
 * The **existence** of a slug is checked against the `SkinConcern` table
 * at the service layer — see `src/lib/admin/catalog.ts`. The schema here
 * only checks the *shape*, because the vocabulary is a table, not a
 * constant: an admin can add "Redness" in the Concerns panel and it is
 * available in this picker immediately, with no code change.
 */
const productConcernSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "A skin concern cannot be empty.")
  .max(MAX_CONCERN_SLUG_LENGTH, "That skin concern is not valid.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "That skin concern is not valid.",
  );

/**
 * A product's skin-concern list.
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 * **1. Duplicates are refused, not merged.**
 *
 * The same reason the badge list refuses them: two entries that name the
 * same concern would render the same concern twice on the product card
 * and count twice towards the browse filter.
 *
 * **2. The list is bounded.**
 *
 * A product that claimed every concern would be findable under every
 * concern page, which makes the browse useless for everyone else.
 */
const productConcernsSchema = z
  .array(productConcernSlugSchema)
  .max(
    MAX_PRODUCT_CONCERNS,
    `A product can carry at most ${MAX_PRODUCT_CONCERNS} skin concerns.`,
  )
  .refine(
    (concerns) => new Set(concerns).size === concerns.length,
    "The same skin concern cannot appear twice.",
  );

export type ProductConcernInput = z.infer<typeof productConcernsSchema>;

/**
 * A product's cost and selling price, in poisha.
 *
 * ── Why these are optional ───────────────────────────────────────────────
 *
 * A product the shop has not bought yet has no purchase price, and a
 * product that is not yet priced for sale has no selling price. Both
 * are ordinary states, so both are nullable — and `null` means "not
 * known".
 *
 * A non-null default of `0` would be worse than useless: it would say
 * the product cost nothing, and a margin computed against it would
 * report a 100% profit on a product the shop paid real money for. The
 * profit figures **exclude** products with no recorded cost rather than
 * counting them at zero.
 *
 * ── Why `null` and "absent" both mean "no cost" ─────────────────────────
 *
 * The same treatment `discountPricePaisa` and `climateTips` get, and
 * for the same reason: the column is `Int?`, and a client that sends
 * `null` and a client that omits the field mean the same thing. The
 * admin form sends `null` for an empty box, and the schema must accept
 * it — otherwise the most ordinary save on the form fails validation
 * with no field named.
 *
 * ── Why the bounds are what they are ────────────────────────────────────
 *
 * The upper bound matches the price bounds: `MAX_MONEY_PAISA` is a
 * million taka, which is more than any single product in this shop is
 * worth, and a value beyond it is a typo rather than a price.
 */
const MAX_MONEY_PAISA = 100_000_000;

const productCostSchema = z
  .number()
  .int("The cost must be a whole number of poisha.")
  .min(0, "The cost cannot be negative.")
  .max(MAX_MONEY_PAISA, "That cost is too large.")
  .nullable()
  .optional();

/**
 * The body of a product creation.
 *
 * ── What the client may and may not send ─────────────────────────────────
 *
 * The client sends the **catalogue facts**: what the product is called,
 * what it costs, which category it belongs to, what is in it, and what
 * it looks like.
 *
 * It does not send:
 *
 *   • **`stockQuantity` as an absolute.** The stock a new product starts
 *     with is `stockQuantity` — it is not derived from anything, because
 *     there is nothing to derive it from. So this one field *is* an
 *     absolute on creation, and it is recorded in the audit entry's
 *     `after` as the opening stock.
 *   • **`archivedAt`.** A product is created live. Archiving is a
 *     separate, deliberate act with its own audit entry.
 *   • **The ids of anything else.** The category is named by its id, and
 *     the service checks it exists.
 */
export const productCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The product needs a name.")
    .max(160, "That name is too long."),
  description: z
    .string()
    .trim()
    .max(2000, "That description is too long.")
    .nullable()
    .optional(),
  /**
   * The product's brand.
   *
   * Optional — a product can have no brand. See `productBrandSchema`.
   */
  brand: productBrandSchema.nullable().optional(),
  categoryId: entityIdSchema,
  pricePaisa: z
    .number()
    .int("The price must be a whole number of poisha.")
    .min(0, "The price cannot be negative.")
    .max(100_000_000, "That price is too large."),
  /**
   * The discount price, in poisha.
   *
   * Nullable, for the same reason `climateTips` is: the column is
   * `Int?` and "no discount" is a real, ordinary state. A client that
   * sends `null` and a client that omits the field mean the same
   * thing, and both are accepted.
   */
  discountPricePaisa: z
    .number()
    .int("The discount price must be a whole number of poisha.")
    .min(0, "The discount price cannot be negative.")
    .max(100_000_000, "That discount price is too large.")
    .nullable()
    .optional(),
  /**
   * What the shop paid for one unit, in poisha.
   *
   * Optional — a product's cost may not be known yet. See
   * `productCostSchema`.
   */
  purchasePricePaisa: productCostSchema,
  /**
   * What the customer is charged for one unit, in poisha.
   *
   * Optional — a product's selling price may not be known yet. See
   * `productCostSchema`.
   */
  sellingPricePaisa: productCostSchema,
  stockQuantity: z
    .number()
    .int("The stock must be a whole number of units.")
    .min(0, "The stock cannot be negative.")
    .max(100_000, "That stock quantity is too large.")
    .default(0),
  ingredientTags: z.array(z.string().trim().max(64)).max(100).default([]),
  /**
   * The skin concerns this product addresses — "Shop by Concern".
   *
   * The slugs of the concerns in the `SkinConcern` table. The service
   * checks each one against that table before the write, so a slug for a
   * concern that does not exist cannot be stored.
   *
   * **Optional**, and an absent list means "no concerns" — the same
   * thing an empty list means. It is optional rather than defaulted so
   * that a caller who does not care about concerns does not have to name
   * the field at all.
   */
  concernSlugs: productConcernsSchema.optional(),
  /**
   * The climate tips.
   *
   * **Nullable, and this matters.**
   *
   * The column is `String?` — a product may genuinely have no climate
   * tips — and the service already reads `input.climateTips ?? null`.
   * So the *storage* layer has always accepted `null`; only the schema
   * did not, and the admin form sends `null` for an empty field.
   *
   * That combination is what made product creation fail with "The
   * request failed validation" on a form the admin had filled in
   * correctly: the form sent `null`, the schema wanted a string, and
   * the error the admin saw named no field.
   *
   * `null` and "absent" both mean "no climate tips", and both are
   * accepted — the same pair the update schema accepts, so the two
   * routes cannot disagree about what a client may send.
   */
  climateTips: z.string().trim().max(1000).nullable().optional(),
  images: productImagesSchema.default([]),
  /**
   * The promotional badges.
   *
   * The **source of truth** for the product's promotional labels. The
   * two booleans below are derived from it by the service.
   */
  badges: productBadgesSchema.default([]),
  /**
   * The legacy "new arrival" flag.
   *
   * **Optional**, because the badge list already carries it. A client
   * that predates the badge list still sends this — and the service
   * folds it into the list — but a client that sends only the list
   * must not be made to also send a boolean that says the same thing.
   *
   * So this may only ever **add** a badge. It can never remove one
   * that the list carries, because the list is the source of truth.
   */
  isNewArrival: z.boolean().optional(),
  /**
   * The legacy "best seller" flag. See `isNewArrival` above.
   */
  isBestSeller: z.boolean().optional(),
});

export type ProductCreateInput = z.infer<typeof productCreateSchema>;

/**
 * The body of a product update.
 *
 * **Every field is optional.** A partial update changes only what it
 * names — a save that changes the name and the description does not
 * silently reset the price.
 *
 * ── Why there is no `stockQuantity` here ──────────────────────────────────
 *
 * Stock is a **derived** value: a checkout deducts a unit at the moment
 * a customer orders. An Edit form that wrote an absolute stock quantity
 * would destroy a concurrent checkout's reservation without any trace —
 * the two operations look identical in the database.
 *
 * So a stock change on the Edit form is expressed as a **signed
 * `stockDelta`**, and it is routed through the existing stock service, so
 * it keeps the `PRODUCT_STOCK_ADJUSTED` audit trail and the conditional
 * update that makes two admins safe.
 */
export const productUpdateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "The product needs a name.")
      .max(160, "That name is too long.")
      .optional(),
    description: z.string().trim().max(2000, "That description is too long.").optional(),
    /**
     * The product's brand.
     *
     * Optional, and **nullable** — `null` clears the brand. An absent
     * field leaves the brand alone, which is what a partial update
     * means everywhere else in this schema.
     */
    brand: productBrandSchema.nullable().optional(),
    categoryId: entityIdSchema.optional(),
    pricePaisa: z
      .number()
      .int("The price must be a whole number of poisha.")
      .min(0, "The price cannot be negative.")
      .max(100_000_000, "That price is too large.")
      .optional(),
    discountPricePaisa: z
      .number()
      .int("The discount price must be a whole number of poisha.")
      .min(0, "The discount price cannot be negative.")
      .max(100_000_000, "That discount price is too large.")
      .nullable()
      .optional(),
    /**
     * What the shop paid for one unit, in poisha.
     *
     * Optional, and **nullable** — `null` clears the recorded cost.
     * An absent field leaves the cost alone, which is what a partial
     * update means everywhere else in this schema.
     */
    purchasePricePaisa: productCostSchema,
    /**
     * What the customer is charged for one unit, in poisha.
     *
     * Optional, and **nullable** — `null` clears the recorded selling
     * price. An absent field leaves it alone.
     */
    sellingPricePaisa: productCostSchema,
    ingredientTags: z.array(z.string().trim().max(64)).max(100).optional(),
    /**
     * The skin concerns this product addresses.
     *
     * **Replacing, not merging.** An absent list leaves the concerns
     * alone; a present list replaces them wholesale. That is what a
     * partial update means everywhere else in this schema — and it is
     * the only way a concern can be **removed**, which a list that could
     * only grow would make impossible.
     */
    concernSlugs: productConcernsSchema.optional(),
    climateTips: z.string().trim().max(1000).nullable().optional(),
    /**
     * The image list.
     *
     * **Replacing, not merging.** An absent list leaves the images
     * alone; a present list replaces them wholesale. That is what a
     * partial update means everywhere else in this schema — it changes
     * what it names and nothing else.
     *
     * `null` is accepted and means "no images", the same thing an
     * empty list means — so the two schemas cannot disagree about what
     * a client may send.
     */
    images: productImagesSchema.optional(),
    /**
     * The promotional badges.
     *
     * **Replacing, not merging.** An absent list leaves the badges
     * alone; a present list replaces them wholesale. That is what a
     * partial update means everywhere else in this schema — it changes
     * what it names and nothing else — and a badge list that could only
     * grow would make it impossible to remove a badge.
     */
    badges: productBadgesSchema.optional(),
    isNewArrival: z.boolean().optional(),
    isBestSeller: z.boolean().optional(),
    /**
     * A signed change to the stock.
     *
     * Routed through the stock service, so it gets its own audit entry.
     * It cannot be zero — "change the stock by zero" is not a change.
     */
    stockDelta: z
      .number()
      .int("The stock change must be a whole number of units.")
      .min(-10_000, "That change is too large.")
      .max(10_000, "That change is too large.")
      .refine((value) => value !== 0, "The stock change must change something.")
      .optional(),
    /**
     * The reason for the change.
     *
     * **Mandatory when the price changes**, and optional otherwise. The
     * price is a commercial decision, and an audit entry that says
     * "price 95000 → 120000" with no reason cannot answer "why".
     */
    reason: z.string().trim().max(500, "That reason is too long.").optional(),
  })
  .refine(
    (value) =>
      value.pricePaisa === undefined ||
      value.discountPricePaisa === undefined ||
      value.discountPricePaisa === null ||
      value.discountPricePaisa <= value.pricePaisa,
    {
      message: "The discount price cannot be higher than the price.",
      path: ["discountPricePaisa"],
    },
  );

export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

/**
 * The body of a product deletion.
 *
 * ── Why the confirmation is typed ────────────────────────────────────────
 *
 * A destructive action with one click is a destructive action somebody
 * will do by accident. Typing the product's name is the standard
 * confirmation for "this exact thing" — it is unambiguous, and it
 * cannot be satisfied by a stray keystroke.
 *
 * And the **reason is mandatory**. A deletion is the one admin action
 * that leaves nothing behind to inspect, so the record of why is the
 * only thing that remains.
 */
export const productDeleteSchema = z.object({
  /**
   * The product's name, typed by the admin.
   */
  confirmName: z
    .string()
    .trim()
    .min(1, "Type the product's name to confirm.")
    .max(160, "That name is too long."),
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason for the deletion.")
    .max(500, "That reason is too long."),
  /**
   * Whether to archive or to delete outright.
   *
   * `archive` is the default — it withdraws the product from sale while
   * preserving the order history. `hard` removes the row entirely, and
   * is only possible for a product with no orders, no cart items and no
   * reviews.
   */
  mode: z.enum(["archive", "hard"]).default("archive"),
});

export type ProductDeleteInput = z.infer<typeof productDeleteSchema>;

/**
 * The query for the admin user list.
 *
 * The user list is **read-only**, so this schema has no mutation
 * counterpart. There is deliberately no `role` filter: an admin cannot
 * change a role, so filtering by one would imply a capability that does
 * not exist.
 */
export const adminUserQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminUserQuery = z.infer<typeof adminUserQuerySchema>;

/**
 * The body of an AI configuration update.
 *
 * Every field is optional — a partial update changes only what it
 * names. `disclaimerVersion` is **absent on purpose**: it is a stamp
 * the service increments when the disclaimer text changes, not a value
 * an admin sets. A client that could set it directly could make two
 * different disclaimers share a version number, which would destroy
 * the audit trail the stamp exists to provide.
 */
export const aiConfigUpdateSchema = z.object({
  /**
   * The exact text shown to users during an advisor conversation.
   *
   * Bounded, and refused when empty — an empty disclaimer is a
   * configuration error, not a request to show nothing. The service
   * falls back to the hardcoded text in any case, so an empty string
   * here would silently do nothing while appearing to succeed.
   */
  disclaimerText: z
    .string()
    .trim()
    .min(1, "The disclaimer cannot be empty.")
    .max(2000, "That disclaimer is too long.")
    .optional(),
  /**
   * The products the AI may recommend. An empty list means "all".
   */
  aiProductIds: z.array(entityIdSchema).max(500).optional(),
  /**
   * The prompt override. An empty string clears the override.
   */
  systemPrompt: z
    .string()
    .trim()
    .max(4000, "That prompt is too long.")
    .optional(),
  /**
   * Whether the AI must not recommend a product that conflicts with
   * anything already in the customer's cart.
   */
  enforceCartConflicts: z.boolean().optional(),
});

export type AiConfigUpdateInput = z.infer<typeof aiConfigUpdateSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The announcement marquee
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The marquee's link destination.
 *
 * ── Why the path is restricted ─────────────────────────────────────────────
 *
 * The marquee's text is rendered into an `<a href>` on every page of the
 * storefront. A destination that could point anywhere is a destination
 * that could point at `javascript:…`, at another host, or at a `data:`
 * URI that replaces the shop with a phishing form.
 *
 * So the rule is the same one the hero banner's calls to action follow,
 * and the same one the codebase applies everywhere a link is
 * admin-authored: **a path within the storefront, and nothing else.**
 *
 * A path starting with `/` is internal. One starting with `//` is a
 * protocol-relative URL to another host, and it is refused for the same
 * reason an absolute URL is.
 */
const marqueeHrefSchema = z
  .string()
  .trim()
  .min(1, "The link cannot be empty.")
  .max(255, "That link is too long.")
  .regex(/^\/(?!\/)/, "The link must be a path within the shop.")
  .optional();

/**
 * A marquee colour.
 *
 * ── Why the shape is this strict ──────────────────────────────────────────
 *
 * The colour is rendered into a `style` attribute on the bar. Anything
 * that is not a hex triplet is refused, for two reasons:
 *
 *   1. **It is untrusted input.** The value is stored in the database
 *      and written into the page. A string that closed the declaration
 *      early could carry a second property, and a `url(…)` could pull
 *      a remote image into the bar. The pattern admits a `#` and six
 *      hex digits and nothing else.
 *
 *   2. **A colour picker produces one form.** The browser's native
 *      picker always hands back `#rrggbb`, so the strictest shape that
 *      accepts the picker's own output costs the admin nothing.
 *
 * The three-digit form is **accepted** and expanded, because a human
 * typing `#fff` means white and refusing it would be pedantry. The
 * expansion happens in the service, so the database holds one canonical
 * spelling per colour.
 */
const marqueeColorSchema = z
  .string()
  .trim()
  .regex(
    /^#(?:[0-9a-f]{6}|[0-9a-f]{3})$/i,
    "Use a hex colour such as #1c1917.",
  );

/**
 * The shop's support email address.
 *
 * Optional, and **empty is allowed** — an empty address means the
 * footer does not show an email line, which is a real state a real
 * shop can be in.
 *
 * The shape is the shared `emailSchema`'s, but the **empty** case is
 * added rather than the shared schema being reused directly: that
 * schema's first rule is that an email is required, which is exactly
 * the rule that does not apply here.
 */
const supportEmailSchema = z
  .string()
  .trim()
  .max(255, "That email address is too long.")
  .refine(
    (value) => value === "" || z.email().safeParse(value).success,
    "Enter a valid email address.",
  );

/**
 * The shop's support telephone number.
 *
 * A **display** string, not a dialable one — the shop writes it the
 * way it reads it, and the `tel:` link is built from the digits.
 *
 * Only the length is checked here. The number's shape is the country's
 * business, not the validation layer's, and a shop's support line may
 * legitimately be a landline, a `01819-000000`, or a number with an
 * extension in it.
 */
const supportPhoneSchema = z
  .string()
  .trim()
  .max(40, "That phone number is too long.");

/**
 * The shop's opening hours.
 *
 * Free text, because a shop's hours are a sentence — "Saturday to
 * Thursday, 10am–8pm" — and a rigid week-of-times structure could not
 * hold it.
 */
const supportHoursSchema = z
  .string()
  .trim()
  .max(120, "Those opening hours are too long.");

/**
 * The shop's store address.
 *
 * Free text, and possibly more than one line. An address is an
 * address; it is not a set of structured parts that every shop fills
 * in the same way.
 */
const storeAddressSchema = z
  .string()
  .trim()
  .max(400, "That address is too long.");

/**
 * The body of a site-settings update.
 *
 * Every field is optional — a partial update changes only what it
 * names. The admin form sends only the fields the admin touched, so
 * editing the marquee's text cannot silently switch the marquee on.
 */
export const siteSettingsUpdateSchema = z
  .object({
    /**
     * Whether the marquee is shown on the storefront.
     *
     * A **switch**, not a value. The marquee is either on the page or
     * it is not.
     */
    isMarqueeEnabled: z.boolean().optional(),
    /**
     * The marquee's copy — the words that scroll.
     *
     * Bounded. The text is repeated across a scrolling strip, so a
     * paragraph would be unreadable and would make the scroll feel
     * broken rather than deliberate.
     *
     * An **empty** string is refused. The marquee is a single line of
     * marketing copy: a marquee with no text is a strip of coloured
     * nothing, which looks like something broke. An admin who wants no
     * marquee switches it **off**, which is what the switch is for.
     */
    marqueeText: z
      .string()
      .trim()
      .min(1, "The marquee needs some text. Switch it off instead.")
      .max(240, "That marquee text is too long.")
      .optional(),
    /**
     * Where the marquee links to.
     *
     * `null` clears the link — the marquee then announces without
     * inviting a click.
     */
    marqueeHref: marqueeHrefSchema.nullable().optional(),
    /**
     * The marquee's ground.
     *
     * A hex triplet. The **pair** must be legible together, but that
     * is a rule about the stored state — a request that changes only
     * the ground changes the pair — so it is enforced by the service,
     * which can see the type that is already saved.
     */
    marqueeBgColor: marqueeColorSchema.optional(),
    /**
     * The marquee's type colour. A hex triplet.
     */
    marqueeTextColor: marqueeColorSchema.optional(),
    /**
     * The shop's support email address.
     *
     * Empty is allowed and means "the footer shows no email line".
     */
    supportEmail: supportEmailSchema.optional(),
    /**
     * The shop's support telephone number, as it is displayed.
     */
    supportPhone: supportPhoneSchema.optional(),
    /**
     * The shop's opening hours.
     */
    supportHours: supportHoursSchema.optional(),
    /**
     * The shop's store address.
     */
    storeAddress: storeAddressSchema.optional(),
  });

export type SiteSettingsUpdateInput = z.infer<typeof siteSettingsUpdateSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The signed-in administrator's own profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The body of an admin profile update.
 *
 * ── Why this is its own vocabulary ─────────────────────────────────────────
 *
 * The admin's own details are edited by the admin, about the admin. That
 * makes them a different kind of thing from the **shop's** settings:
 *
 *   • The shop's settings are shared. Every admin sees the same marquee
 *     and the same contact details, and changing them is a commercial
 *     decision that affects customers.
 *   • The admin's profile is **private to that admin**. Changing the
 *     admin's phone number does not change the shop's support number, and
 *     the two are stored in different places — `users.phone` against
 *     `site_settings.support_phone`.
 *
 * So they get their own schema rather than a flag on the site-settings
 * one. Reusing the shop's schema would have made it far too easy to
 * write `supportPhone` where `phone` was meant, and the two would look
 * the same in a diff.
 *
 * ── Why every field is optional ────────────────────────────────────────────
 *
 * A partial update changes only what it names. The admin profile form
 * sends only the fields the admin touched, so correcting a typo in the
 * name cannot silently blank the phone number the form happened to be
 * holding.
 *
 * ── Why the role is not editable here ──────────────────────────────────────
 *
 * The role is deliberately **absent** from this schema.
 *
 * A role change is a privilege grant. It belongs to a separate, audited
 * decision made by somebody else — the "Users" page — not to a profile
 * form an admin fills in about themselves. A self-service role field
 * would let any admin promote themselves, and would make the trail's
 * answer to "who granted this and why" unanswerable.
 */

/**
 * The administrator's display name.
 *
 * Bounded at the column's own width (160 characters). It is shown in the
 * top bar and in every audit entry the admin writes, so it is short,
 * human, and never a paragraph.
 */
const adminNameSchema = z
  .string()
  .trim()
  .min(2, "Please enter your name.")
  .max(160, "That name is too long.");

/**
 * The administrator's own telephone number.
 *
 * **Optional, and empty is allowed** — an empty number means "no number
 * on file", which is a real state and is different from "not known".
 *
 * It is a **display** string, not a dialable one, for the same reason the
 * shop's support number is: the admin writes it the way they read it, and
 * the digits are taken from it.
 *
 * The length is bounded by the column's own width (20 characters). A
 * Bangladeshi mobile number is 11 digits; with a country code and
 * spaces it is 14. Twenty characters leaves room for an extension
 * without leaving room for a paragraph.
 */
const adminPhoneSchema = z
  .string()
  .trim()
  .max(20, "That phone number is too long.");

/**
 * The keys an admin profile body must never carry.
 *
 * ── Why these are declared rather than simply left out ────────────────────
 *
 * A Zod object that does not mention a key **strips** it in silence. So a
 * schema without these fields would not *refuse* a request that tried to
 * change the email address or the role — it would accept the request,
 * discard the field, and write nothing. The admin would see a success
 * message for a change that had not happened.
 *
 * That is the codebase's rule stated in its own words at the top of this
 * file: **invalid input is rejected, never silently ignored.**
 *
 * So the forbidden keys are declared as `z.unknown().optional()` and then
 * refused explicitly. The same pattern the hero banner uses for its
 * retired showcase keys.
 */
const ADMIN_PROFILE_FORBIDDEN_KEYS = [
  /**
   * The email address.
   *
   * The account's identity, and the destination of every password
   * reset. The shop owns an email-verification flow, so a
   * self-service change would have to prove the new address before it
   * could be trusted — and until that is wired up, the honest answer is
   * to refuse the field rather than accept it and skip the proof.
   */
  "email",
  /**
   * The role.
   *
   * A privilege grant. It is somebody else's decision — made on the
   * Users page, by another administrator, and recorded there. A
   * self-service role field would let any admin promote themselves.
   */
  "role",
  /**
   * The SMS consent flag.
   *
   * `User.smsOptIn` is the **only** flag that authorises the platform
   * to send a depletion reminder, and it is a decision about *being
   * messaged* rather than about what number to be messaged at. Editing
   * it in the profile form would let an admin quietly authorise
   * messages without going through the storefront's own consent flow.
   */
  "smsOptIn",
  /**
   * The user id.
   *
   * The id the write applies to comes from the **session**, and is not
   * in the request at all. A body that names an id is a body that is
   * trying to write to somebody else's row.
   */
  "id",
] as const;

/**
 * Refuses any of the forbidden keys on an admin profile body.
 *
 * The check fires only when a key is **present**. A body that carries
 * none of them — which is every legitimate body — is unaffected.
 *
 * The message names the field, because "that request is not allowed" is
 * not something an admin can act on. "Your role cannot be changed here"
 * is.
 */
function refuseForbiddenProfileFields(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const messages: Record<(typeof ADMIN_PROFILE_FORBIDDEN_KEYS)[number], string> =
    {
      email:
        "Your email address is your account's identity, so it cannot be changed here. Ask another administrator to change it for you.",
      role: "Your role cannot be changed here. A role change is made by another administrator on the Users page.",
      smsOptIn:
        "Your SMS reminders cannot be changed here. That is a decision about being messaged, so it is set on your storefront account.",
      id: "That field cannot be changed here. Your profile is changed by the signed-in administrator alone.",
    };

  for (const key of ADMIN_PROFILE_FORBIDDEN_KEYS) {
    if (value[key] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: messages[key],
      });
    }
  }
}

/**
 * The body of an admin profile update.
 */
export const adminProfileUpdateSchema = z
  .object({
    /**
     * The administrator's display name.
     */
    name: adminNameSchema.optional(),
    /**
     * The administrator's telephone number. An empty string clears it.
     */
    phone: adminPhoneSchema.optional(),
    /*
     * The forbidden keys are declared so they can be **refused**. They
     * are `z.unknown()` rather than typed fields because their value does
     * not matter — only their presence does.
     */
    email: z.unknown().optional(),
    role: z.unknown().optional(),
    smsOptIn: z.unknown().optional(),
    id: z.unknown().optional(),
  })
  .superRefine(refuseForbiddenProfileFields);

export type AdminProfileUpdateInput = z.infer<typeof adminProfileUpdateSchema>;

/**
 * How a coupon's discount is calculated.
 *
 * Mirrors the `CouponDiscountType` enum. It is declared here rather than
 * imported from Prisma so the validation layer stays independent of the
 * database schema — the same reason `commerce.ts` and `admin.ts` are
 * separate files.
 */
export const couponDiscountTypeSchema = z.enum(["PERCENTAGE", "FIXED"]);

export type CouponDiscountTypeInput = z.infer<
  typeof couponDiscountTypeSchema
>;

/**
 * A coupon code.
 *
 * Normalised to uppercase by the service, not here — the schema's job is
 * to reject what is unacceptable, and "eid2026" is an acceptable code
 * that merely needs folding.
 */
const couponCodeSchema = z
  .string()
  .trim()
  .min(3, "The code needs at least three characters.")
  .max(40, "That code is too long.")
  .regex(
    /^[A-Z0-9_-]+$/i,
    "Use letters, numbers, dashes and underscores only.",
  );

/**
 * The body of a coupon creation.
 *
 * The two-discount rule — one of `percentOff` / `amountOffPaisa`, never
 * both — is enforced by the **service**, which is the only place that
 * knows which column belongs to which discount type. The schema cannot
 * express it: a body that names `discountType` plus both amounts is
 * invalid in one combination and merely redundant in another, and only
 * the service can tell those apart.
 */
export const couponCreateSchema = z.object({
  code: couponCodeSchema,
  /**
   * The description.
   *
   * `null` is accepted, not just a string and "absent". A coupon with
   * no description is perfectly ordinary, and the admin form sends
   * `null` for an empty box — so a schema that accepts only a string
   * would refuse the most common creation there is.
   */
  description: z
    .string()
    .trim()
    .max(200, "That description is too long.")
    .nullable()
    .optional(),
  discountType: couponDiscountTypeSchema,
  percentOff: z
    .number()
    .int("The percentage must be a whole number.")
    .min(1, "The percentage must be at least 1.")
    .max(100, "The percentage cannot be more than 100.")
    .optional(),
  amountOffPaisa: z
    .number()
    .int("The amount must be a whole number of poisha.")
    .min(1, "The amount must be more than zero.")
    .max(100_000_000, "That amount is too large.")
    .optional(),
  expiresAt: z.coerce
    .date("The expiry date is not a valid date.")
    .refine((date) => date.getTime() > Date.now(), "The expiry date must be in the future."),
  usageLimit: z
    .number()
    .int("The usage limit must be a whole number.")
    .min(1, "The usage limit must be at least 1.")
    .max(1_000_000, "That usage limit is too large.")
    .optional(),
  isActive: z.boolean().default(true),
  reason: z.string().trim().max(500, "That reason is too long.").optional(),
});

export type CouponCreateInput = z.infer<typeof couponCreateSchema>;

/**
 * The body of a coupon update.
 *
 * Every field is optional — a partial update changes only what it
 * names. `reason` is **mandatory when the discount terms change**, and
 * optional otherwise; the service enforces that pairing, because only
 * it knows whether the terms actually moved.
 */
export const couponUpdateSchema = z.object({
  description: z.string().trim().max(200, "That description is too long.").nullable().optional(),
  discountType: couponDiscountTypeSchema.optional(),
  percentOff: z
    .number()
    .int("The percentage must be a whole number.")
    .min(1, "The percentage must be at least 1.")
    .max(100, "The percentage cannot be more than 100.")
    .nullable()
    .optional(),
  amountOffPaisa: z
    .number()
    .int("The amount must be a whole number of poisha.")
    .min(1, "The amount must be more than zero.")
    .max(100_000_000, "That amount is too large.")
    .nullable()
    .optional(),
  expiresAt: z.coerce
    .date("The expiry date is not a valid date.")
    .refine((date) => date.getTime() > Date.now(), "The expiry date must be in the future.")
    .optional(),
  usageLimit: z
    .number()
    .int("The usage limit must be a whole number.")
    .min(1, "The usage limit must be at least 1.")
    .max(1_000_000, "That usage limit is too large.")
    .nullable()
    .optional(),
  isActive: z.boolean().optional(),
  reason: z.string().trim().max(500, "That reason is too long.").optional(),
});

export type CouponUpdateInput = z.infer<typeof couponUpdateSchema>;

/**
 * The body of a coupon deactivation.
 *
 * The **reason is mandatory**. Deactivating a coupon stops an advertised
 * discount working, and a customer holding that code is entitled to an
 * explanation.
 */
export const couponDeactivateSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason for deactivating the coupon.")
    .max(500, "That reason is too long."),
});

export type CouponDeactivateInput = z.infer<typeof couponDeactivateSchema>;

/**
 * The query for the admin coupon list.
 */
export const adminCouponQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminCouponQuery = z.infer<typeof adminCouponQuerySchema>;

/**
 * The action filter for the audit-trail explorer.
 *
 * The values are the `AdminAction` enum, and the schema declares them
 * explicitly rather than deriving them from Prisma — the validation
 * layer stays independent of the database schema, so a new enum member
 * does not silently become a filterable action until somebody adds it
 * here on purpose.
 *
 * An unrecognised value is an **error**, not a default. An admin who
 * filters for something the server does not recognise and gets back an
 * unfiltered list would have no way of knowing their filter was ignored.
 */
export const auditActionFilterSchema = z.enum([
  "REVIEW_APPROVED",
  "REVIEW_HIDDEN",
  "REVIEW_UNHIDDEN",
  "ORDER_STATUS_CHANGED",
  "ORDER_PAYMENT_STATUS_CHANGED",
  "ORDER_CANCELLED",
  "SMS_REMINDER_SWEEP",
  "SMS_REMINDER_SENT",
  "SMS_REMINDER_RESENT",
  "PRODUCT_STOCK_ADJUSTED",
  "PRODUCT_CREATED",
  "PRODUCT_UPDATED",
  "PRODUCT_DELETED",
  "AI_CONFIG_UPDATED",
  "COUPON_CREATED",
  "COUPON_UPDATED",
  "COUPON_DELETED",
  "CATEGORY_CREATED",
  "CATEGORY_UPDATED",
  "CATEGORY_DELETED",
  "CONCERN_CREATED",
  "CONCERN_UPDATED",
  "CONCERN_DELETED",
  "BRAND_CREATED",
  "BRAND_UPDATED",
  "BRAND_DELETED",
  "HERO_BANNER_CREATED",
  "HERO_BANNER_UPDATED",
  "HERO_BANNER_DELETED",
]);

export type AuditActionFilter = z.infer<typeof auditActionFilterSchema>;

/**
 * The entity-type filter for the audit-trail explorer.
 *
 * A **closed set**, taken from `AUDIT_ENTITY_TYPES` — the same list the
 * audit writer uses. An unrecognised type is an error, not a default:
 * an admin who filters for something the server does not recognise and
 * gets back an empty list has no way of knowing their filter was
 * ignored.
 */
export const auditEntityTypeFilterSchema = z.enum(AUDIT_ENTITY_TYPES);

export type AuditEntityTypeFilter = z.infer<
  typeof auditEntityTypeFilterSchema
>;

/**
 * The query for the audit-trail explorer.
 */
export const adminAuditLogQuerySchema = z.object({
  action: auditActionFilterSchema.optional(),
  entityType: auditEntityTypeFilterSchema.optional(),
  actorId: entityIdSchema.optional(),
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminAuditLogQuery = z.infer<typeof adminAuditLogQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The discovery sections — categories, concerns and brands
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A URL-friendly slug.
 *
 * The storefront links to `/products?category=<slug>`, so a slug is part
 * of a URL and part of the admin's mental model of the category. It is
 * restricted to lowercase letters, digits and dashes for exactly that
 * reason: a slug with a space in it is a slug that has to be encoded
 * everywhere it is used.
 */
const slugSchema = z
  .string()
  .trim()
  .min(1, "A slug is required.")
  .max(140, "That slug is too long.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, digits and single dashes only.",
  );

/**
 * A discovery entity's image reference.
 *
 * ── Why this is the same rule as a product's image ───────────────────────
 *
 * The column holds a **storage key**, not a URL — "Storage adapter keys —
 * NOT raw URLs, so the driver can be swapped" — and the key must point
 * inside the upload root. The product's image entry already encodes
 * exactly that rule, including the legacy absolute-path repair, so the
 * discovery schemas reuse it rather than writing a second, weaker copy.
 *
 * A **single** image, unlike a product's list of twenty. A category, a
 * concern and a brand each show one picture.
 */
const discoveryImageSchema = productImageEntrySchema.nullable().optional();

/**
 * The body of a category creation.
 */
export const categoryCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The category needs a name.")
    .max(120, "That name is too long."),
  slug: slugSchema,
  /**
   * The category's card image.
   *
   * A storage key, uploaded separately. Absent or `null` means "no
   * image", and the storefront falls back to the SVG icon keyed by slug.
   */
  image: discoveryImageSchema,
});

export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;

/**
 * The body of a category update.
 *
 * Every field is optional — a partial update changes only what it names.
 */
export const categoryUpdateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The category needs a name.")
    .max(120, "That name is too long.")
    .optional(),
  slug: slugSchema.optional(),
  /**
   * The category's card image. `null` clears it.
   */
  image: productImageEntrySchema.nullable().optional(),
});

export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;

/**
 * The body of a category deletion.
 *
 * The **reason is mandatory** — a deletion is the one admin action that
 * leaves nothing behind to inspect, so the record of why is the only thing
 * that remains.
 *
 * A category that still has products **cannot** be deleted: the products
 * reference it, and the database refuses. The service reports the count
 * rather than letting the admin discover it as a bare conflict.
 */
export const categoryDeleteSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason for the deletion.")
    .max(500, "That reason is too long."),
});

export type CategoryDeleteInput = z.infer<typeof categoryDeleteSchema>;

/**
 * The query for the admin category list.
 */
export const adminCategoryQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminCategoryQuery = z.infer<typeof adminCategoryQuerySchema>;

/**
 * The body of a concern creation.
 *
 * The `tag` must be one of the **canonical ingredient IDs** — the same
 * list the conflict engine compares. That is what makes a concern filter
 * and a conflict rule agree about what "BHA" means.
 */
export const concernCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The concern needs a name.")
    .max(80, "That name is too long."),
  slug: slugSchema,
  /**
   * The lead ingredient tag the concern filters on.
   */
  tag: z
    .string()
    .trim()
    .min(1, "Choose the ingredient this concern filters on.")
    .max(60, "That ingredient tag is too long."),
  /**
   * The other tags in this family, offered in the filter panel.
   */
  relatedTags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  /**
   * The concern's card image. Absent or `null` means "no image", and the
   * storefront falls back to the plain chip presentation.
   */
  image: discoveryImageSchema,
  description: z
    .string()
    .trim()
    .max(200, "That description is too long.")
    .nullable()
    .optional(),
});

export type ConcernCreateInput = z.infer<typeof concernCreateSchema>;

/**
 * The body of a concern update.
 *
 * Every field is optional — a partial update changes only what it names.
 */
export const concernUpdateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The concern needs a name.")
    .max(80, "That name is too long.")
    .optional(),
  slug: slugSchema.optional(),
  tag: z
    .string()
    .trim()
    .min(1, "Choose the ingredient this concern filters on.")
    .max(60, "That ingredient tag is too long.")
    .optional(),
  relatedTags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  /**
   * The concern's card image. `null` clears it.
   */
  image: productImageEntrySchema.nullable().optional(),
  description: z
    .string()
    .trim()
    .max(200, "That description is too long.")
    .nullable()
    .optional(),
});

export type ConcernUpdateInput = z.infer<typeof concernUpdateSchema>;

/**
 * The body of a concern deletion.
 */
export const concernDeleteSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason for the deletion.")
    .max(500, "That reason is too long."),
});

export type ConcernDeleteInput = z.infer<typeof concernDeleteSchema>;

/**
 * The query for the admin concern list.
 */
export const adminConcernQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminConcernQuery = z.infer<typeof adminConcernQuerySchema>;

/**
 * A brand's monogram.
 *
 * One to four letters. The written monograms are two letters ("CV", "LR",
 * "TO"), but four is allowed so a shop can use a three-letter mark.
 */
const brandMonogramSchema = z
  .string()
  .trim()
  .min(1, "The brand needs a monogram.")
  .max(4, "The monogram can be at most four letters.")
  .regex(
    /^[A-Za-z]+$/,
    "Use letters only.",
  )
  .transform((value) => value.toUpperCase());

/**
 * The body of a brand creation.
 *
 * ── Why the name is canonicalised here ────────────────────────────────────
 *
 * `Brand.name` is the string `Product.brand` holds, and the two must
 * agree. So the name is folded to its registry spelling by the same
 * `canonicalBrand` the product path uses — "cerave" and "CeraVe" cannot
 * become two brands, one of which has no products and one of which has
 * all of them.
 */
export const brandCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The brand needs a name.")
    .max(MAX_BRAND_LENGTH, "That brand name is too long.")
    .transform((value) => canonicalBrand(value) ?? value),
  slug: slugSchema,
  /**
   * The two-letter monogram shown when no logo is uploaded.
   */
  monogram: brandMonogramSchema,
  /**
   * The brand's logo. A storage key, uploaded separately.
   *
   * Absent or `null` means "no logo", and the storefront falls back to
   * the monogram — which is the fallback, not a removed feature.
   */
  logo: discoveryImageSchema,
  description: z
    .string()
    .trim()
    .max(200, "That description is too long.")
    .nullable()
    .optional(),
  /**
   * The display order on the storefront. Lower comes first.
   */
  sortOrder: z
    .number()
    .int("The order must be a whole number.")
    .min(0, "The order cannot be negative.")
    .max(10_000, "That order is too large.")
    .default(0),
});

export type BrandCreateInput = z.infer<typeof brandCreateSchema>;

/**
 * The body of a brand update.
 *
 * Every field is optional — a partial update changes only what it names.
 */
export const brandUpdateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The brand needs a name.")
    .max(MAX_BRAND_LENGTH, "That brand name is too long.")
    .transform((value) => canonicalBrand(value) ?? value)
    .optional(),
  slug: slugSchema.optional(),
  monogram: brandMonogramSchema.optional(),
  /**
   * The brand's logo. `null` clears it.
   */
  logo: productImageEntrySchema.nullable().optional(),
  description: z
    .string()
    .trim()
    .max(200, "That description is too long.")
    .nullable()
    .optional(),
  sortOrder: z
    .number()
    .int("The order must be a whole number.")
    .min(0, "The order cannot be negative.")
    .max(10_000, "That order is too large.")
    .optional(),
});

export type BrandUpdateInput = z.infer<typeof brandUpdateSchema>;

/**
 * The body of a brand deletion.
 *
 * ── Why a brand deletion is not destructive ───────────────────────────────
 *
 * `Product.brand` is a plain string, not a foreign key, so removing a
 * brand row does **not** remove the products that carry that brand name.
 * They simply have no logo to show, because the storefront falls back to
 * the monogram.
 *
 * So the reason is the record of *why the shop stopped featuring it* — a
 * commercial decision, and the only thing left to inspect afterwards.
 */
export const brandDeleteSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason for the deletion.")
    .max(500, "That reason is too long."),
});

export type BrandDeleteInput = z.infer<typeof brandDeleteSchema>;

/**
 * The query for the admin brand list.
 */
export const adminBrandQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminBrandQuery = z.infer<typeof adminBrandQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The homepage hero banners
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A hero banner's call-to-action destination.
 *
 * ── Why the path is restricted ────────────────────────────────────────────
 *
 * A call to action that can point anywhere is a call to action that can
 * point at `javascript:…`, at another shop, at a data URI that replaces
 * the storefront with a phishing form. The href is rendered into an
 * `href` attribute on a `<Link>`, and the shop's own links are all
 * **paths within the storefront**.
 *
 * So the rule is simple and closed: a banner may link to a path, and to
 * nothing else. A path starting with `/` is internal; one starting with
 * `//` is a protocol-relative URL to another host, and it is rejected
 * for the same reason an absolute URL is.
 */
const heroHrefSchema = z
  .string()
  .trim()
  .min(1, "The link cannot be empty.")
  .max(255, "That link is too long.")
  .refine(
    (value) => value.startsWith("/") && !value.startsWith("//"),
    "Use a path within the shop, starting with a single slash.",
  );

/**
 * A hero banner's gradient wash.
 *
 * A Tailwind class string — the same shape the static slides used, so
 * the storefront's slider does not need a second rendering path for
 * database-driven banners.
 *
 * The pattern is deliberately strict. A gradient is a **class list**, and
 * a class list is not a place to put arbitrary text: an unvalidated field
 * ending up in a `class` attribute is a way to smuggle in arbitrary
 * styling. So the value must look like a gradient utility and nothing
 * else.
 */
const heroGradientSchema = z
  .string()
  .trim()
  .min(1, "The gradient is required.")
  .max(255, "That gradient is too long.")
  .regex(
    /^bg-\[linear-gradient\([0-9a-zA-Z_,%#().\s-]+\)\]$/,
    "Use a linear-gradient utility, for example bg-[linear-gradient(135deg,#fdf2f8_0%,#fff7fb_100%)].",
  );

/**
 * A hero banner's accent glow.
 *
 * A single Tailwind background-colour utility. The same reasoning as the
 * gradient: a validated shape, not free text.
 */
const heroGlowSchema = z
  .string()
  .trim()
  .min(1, "The accent colour is required.")
  .max(120, "That accent colour is too long.")
  .regex(
    /^bg-[a-z]+-\d{1,3}(\/\d{1,3})?$/,
    "Use a background-colour utility, for example bg-brand-400/45.",
  );

/**
 * The keys a hero banner must never carry.
 *
 * The hero used to carry a **showcase source** — a brand or a category
 * whose products were resolved into a plate of floating product cards
 * beside the copy. That plate is gone; the hero is a poster now.
 *
 * These are declared **only so they can be refused**. They are listed as
 * `z.unknown().optional()` rather than being left out of the schema
 * entirely, because a schema that does not mention a key cannot check
 * whether the key was present — and these schemas are not `.strict()`,
 * so an unmentioned key is stripped in silence rather than rejected.
 *
 * The consequence of leaving them out would be a *quiet* guarantee: the
 * clutter could not come back through the API, but a body that still
 * named a brand would be discarded without a word, and the rule would
 * be enforced only by whoever wrote the `JSON.stringify`.
 */
const HERO_SHOWCASE_KEYS = ["showcaseBrand", "showcaseCategory"] as const;

/**
 * Refuses any showcase source on a hero banner body.
 *
 * The check fires only when a key is **present**. A body that carries
 * no showcase keys — which is every legitimate body — is unaffected, and
 * the keys are absent from the parsed output.
 */
function refuseHeroShowcase(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  for (const key of HERO_SHOWCASE_KEYS) {
    if (value[key] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "The hero has no product column.",
      });
    }
  }
}

/**
 * The body of a hero banner creation.
 *
 * The trust points are capped at four: the hero shows them in a single
 * row, and a fifth would wrap onto a second line and break the
 * composition.
 */
export const heroBannerCreateSchema = z.object({
  eyebrow: z
    .string()
    .trim()
    .min(1, "The banner needs an eyebrow.")
    .max(80, "That eyebrow is too long."),
  title: z
    .string()
    .trim()
    .min(1, "The banner needs a headline.")
    .max(160, "That headline is too long."),
  body: z
    .string()
    .trim()
    .min(1, "The banner needs a supporting line.")
    .max(400, "That supporting line is too long."),
  ctaLabel: z
    .string()
    .trim()
    .min(1, "The main button needs a label.")
    .max(60, "That label is too long."),
  ctaHref: heroHrefSchema,
  secondaryCtaLabel: z
    .string()
    .trim()
    .min(1, "The second button needs a label.")
    .max(60, "That label is too long."),
  secondaryCtaHref: heroHrefSchema,
  /**
   * The trust points shown under the calls to action.
   */
  trust: z.array(z.string().trim().min(1).max(60)).max(4).default([]),
  /**
   * The banner's background artwork — a **storage key**, uploaded
   * separately. Absent or `null` means "no image", and the storefront
   * falls back to the gradient wash alone.
   */
  image: discoveryImageSchema,
  gradient: heroGradientSchema.default(
    "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]",
  ),
  glow: heroGlowSchema.default("bg-brand-400/45"),
  /**
   * Whether the banner is shown on the storefront.
   */
  isActive: z.boolean().default(true),
  /**
   * The display order in the carousel. Lower comes first.
   */
  sortOrder: z
    .number()
    .int("The order must be a whole number.")
    .min(0, "The order cannot be negative.")
    .max(10_000, "That order is too large.")
    .default(0),
  /**
   * The showcase source, which is never allowed. See
   * `HERO_SHOWCASE_KEYS`.
   */
  showcaseBrand: z.unknown().optional(),
  showcaseCategory: z.unknown().optional(),
}).superRefine(refuseHeroShowcase);

export type HeroBannerCreateInput = z.infer<typeof heroBannerCreateSchema>;

/**
 * The body of a hero banner update.
 *
 * Every field is optional — a partial update changes only what it names.
 */
export const heroBannerUpdateSchema = z.object({
  eyebrow: z
    .string()
    .trim()
    .min(1, "The banner needs an eyebrow.")
    .max(80, "That eyebrow is too long.")
    .optional(),
  title: z
    .string()
    .trim()
    .min(1, "The banner needs a headline.")
    .max(160, "That headline is too long.")
    .optional(),
  body: z
    .string()
    .trim()
    .min(1, "The banner needs a supporting line.")
    .max(400, "That supporting line is too long.")
    .optional(),
  ctaLabel: z
    .string()
    .trim()
    .min(1, "The main button needs a label.")
    .max(60, "That label is too long.")
    .optional(),
  ctaHref: heroHrefSchema.optional(),
  secondaryCtaLabel: z
    .string()
    .trim()
    .min(1, "The second button needs a label.")
    .max(60, "That label is too long.")
    .optional(),
  secondaryCtaHref: heroHrefSchema.optional(),
  trust: z.array(z.string().trim().min(1).max(60)).max(4).optional(),
  /**
   * The banner's background artwork. `null` clears it.
   */
  image: productImageEntrySchema.nullable().optional(),
  gradient: heroGradientSchema.optional(),
  glow: heroGlowSchema.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z
    .number()
    .int("The order must be a whole number.")
    .min(0, "The order cannot be negative.")
    .max(10_000, "That order is too large.")
    .optional(),
  /**
   * The showcase source, which is never allowed. See
   * `HERO_SHOWCASE_KEYS`.
   */
  showcaseBrand: z.unknown().optional(),
  showcaseCategory: z.unknown().optional(),
}).superRefine(refuseHeroShowcase);

export type HeroBannerUpdateInput = z.infer<typeof heroBannerUpdateSchema>;

/**
 * The body of a hero banner deletion.
 *
 * The **reason is mandatory** — a deletion is the one admin action that
 * leaves nothing behind to inspect, so the record of why is the only thing
 * that remains.
 */
export const heroBannerDeleteSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason for the deletion.")
    .max(500, "That reason is too long."),
});

export type HeroBannerDeleteInput = z.infer<typeof heroBannerDeleteSchema>;

/**
 * The query for the admin hero banner list.
 */
export const adminHeroBannerQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(120, "That search term is too long.")
    .optional(),
  ...paginationShape,
});

export type AdminHeroBannerQuery = z.infer<
  typeof adminHeroBannerQuerySchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// The admin notification inbox
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kinds of admin notification.
 *
 * Mirrors the `AdminNotificationKind` enum. Declared here explicitly, for
 * the same reason every other enum-shaped vocabulary in this file is
 * declared explicitly: the validation layer must not depend on the
 * database schema to describe the values a **browser** is allowed to send.
 */
export const adminNotificationKindSchema = z.enum([
  "ORDER_PLACED",
  "PAYMENT_SETTLED",
  "PAYMENT_FAILED",
]);

export type AdminNotificationKindInput = z.infer<
  typeof adminNotificationKindSchema
>;

/**
 * The query for the notification inbox.
 *
 * Only `limit` — the bell shows the most recent handful, and an
 * unbounded inbox would be an unbounded response on a poll.
 *
 * `limit` is capped at 50 for the same reason the service caps it: this
 * runs on a poll, and a poll that can ask for a million rows is a poll
 * that can take the site down.
 */
export const adminNotificationQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int("The limit must be a whole number.")
    .min(1, "The limit must be at least 1.")
    .max(50, "That limit is too large.")
    .default(20),
});

export type AdminNotificationQuery = z.infer<
  typeof adminNotificationQuerySchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// The admin order creation
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line of an admin-created order.
 *
 * **A product id and a quantity. Never a price.**
 *
 * The price is read from the product row inside the transaction. A
 * client-supplied price is a vulnerability, not a convenience, and the
 * same rule the customer checkout obeys applies here — an admin's
 * browser is just as capable of being tampered with as a customer's.
 */
export const adminOrderLineSchema = z.object({
  productId: entityIdSchema,
  quantity: z
    .number()
    .int("The quantity must be a whole number of units.")
    .min(1, "The quantity must be at least one.")
    .max(100, "That quantity is too large.")
    .default(1),
});

/**
 * The body of an admin order creation.
 *
 * The customer must be an **existing account** — the order's `userId`
 * is a foreign key, and creating a user as a side effect of creating
 * an order would need a password policy and an email-verification
 * story that does not belong in the fulfilment desk.
 *
 * The `reason` is **mandatory**. An admin-created order is a decision
 * a staff member made on the shop's behalf — a phone order, a
 * replacement for a returned parcel — and the audit trail has to be
 * able to say which of those it was.
 */
export const adminOrderCreateSchema = z
  .object({
    /**
     * The customer the order is for.
     */
    userId: entityIdSchema,
    fullName: z
      .string()
      .trim()
      .min(2, "Enter the recipient's full name.")
      .max(160, "That name is too long."),
    phone: z
      .string()
      .trim()
      .min(6, "Enter a contact number.")
      .max(20, "That number is too long."),
    addressLine1: z
      .string()
      .trim()
      .min(3, "Enter the street address.")
      .max(200, "That address is too long."),
    addressLine2: z
      .string()
      .trim()
      .max(200, "That address is too long.")
      .optional(),
    city: z
      .string()
      .trim()
      .min(2, "Enter the city or district.")
      .max(120, "That city name is too long."),
    district: z
      .string()
      .trim()
      .min(2, "Enter the district.")
      .max(120, "That district name is too long."),
    postalCode: z
      .string()
      .trim()
      .min(2, "Enter the postal code.")
      .max(10, "That postal code is too long."),
    notes: z
      .string()
      .trim()
      .max(500, "Those notes are too long.")
      .optional(),
    paymentMethod: z.enum(["COD", "BKASH", "NAGAD", "CARD"]),
    paymentTransactionId: z
      .string()
      .trim()
      .max(64, "That transaction ID is too long.")
      .optional(),
    paymentSenderNumber: z
      .string()
      .trim()
      .max(20, "That number is too long.")
      .optional(),
    lines: z.array(adminOrderLineSchema).min(1, "Add at least one item.").max(50),
    reason: z
      .string()
      .trim()
      .min(1, "Give a reason for creating this order.")
      .max(500, "That reason is too long."),
  })
  .refine(
    (value) =>
      value.paymentMethod === "BKASH" ||
      value.paymentMethod === "NAGAD"
        ? Boolean(value.paymentTransactionId)
        : !value.paymentTransactionId && !value.paymentSenderNumber,
    {
      message:
        "A mobile-banking order needs a transaction ID, and a cash or card order must not have one.",
      path: ["paymentTransactionId"],
    },
  );

export type AdminOrderCreateInput = z.infer<typeof adminOrderCreateSchema>;
