import { ApiError } from "@/lib/api/errors";

/**
 * The SSLCOMMERZ gateway.
 *
 * ── What this module is ───────────────────────────────────────────────────
 *
 * A typed, validated wrapper around the `sslcommerz-lts` package. The
 * package itself is untyped CommonJS: it ships no `.d.ts` files, its
 * methods take `any`, and its responses are `any` too. Calling it
 * directly from a route handler would mean every caller re-derives the
 * same knowledge about what the response looks like — and one of them
 * would eventually get it wrong.
 *
 * So this module is the **single** place that knows:
 *
 *   • the shape of an SSLCOMMERZ initiation response,
 *   • the shape of a validation response,
 *   • the parameter names the gateway expects,
 *   • which of those parameters are required.
 *
 * Everything above this module works with the narrow types declared here.
 *
 * ── The rules that shape it ───────────────────────────────────────────────
 *
 * **1. The store credentials are read once, at call time.**
 *
 * Reading `process.env` inside the function rather than at module scope
 * means a missing credential is a clear error at the point of use rather
 * than an `undefined` that surfaces three frames later. It also means the
 * sandbox/live switch is read fresh, which is what makes the sandbox
 * genuinely a switch rather than a build.
 *
 * **2. The amount is the server's number.**
 *
 * `total_amount` is derived from the order row, never from a request
 * body. This module does not enforce that — it has no order to read — but
 * it is why `initiatePayment` takes the amount as an argument rather
 * than accepting a raw parameter bag: the caller has to *have* an
 * amount, and the only way to have one is to have read the order.
 *
 * **3. A response the gateway did not sign off on is a failure.**
 *
 * The gateway answers a failed initiation with HTTP 200 and a body
 * containing `status: "FAILED"`. A caller that only checked the HTTP
 * status would treat a declined session as a successful one and send the
 * customer to a redirect URL that does not exist. So this module checks
 * `status` explicitly and raises on anything but `"SUCCESS"`.
 *
 * **4. The currency is always BDT.**
 *
 * The shop prices in poisha and settles in taka. Converting is the
 * caller's job — this module takes the amount in taka already, because a
 * gateway client that accepted poisha would be a trap: it would look
 * correct and be wrong by a factor of one hundred.
 *
 * **5. The callbacks are absolute URLs.**
 *
 * SSLCOMMERZ redirects the customer's browser to `success_url` from the
 * merchant's own server, so a relative path would be meaningless to it.
 * The base URL is configured once and every callback is built from it.
 *
 * **6. The HTTP transport is ours, not the package's.**
 *
 * The `sslcommerz-lts` package ships an untyped CommonJS transport that
 * calls `require("node-fetch")` directly. Under Turbopack that `require`
 * resolves to a **namespace object** rather than the function, so every
 * gateway call died with `TypeError: fetch is not a function`.
 *
 * The package's knowledge of the gateway — its endpoints, its credential
 * parameters, its field names — is kept and re-expressed here as typed
 * code. The transport is `src/lib/sslcommerz-transport.ts`, which uses
 * the runtime's global `fetch` and the native `FormData`.
 *
 * The practical gain is type-safety: every field the shop sends is now
 * named by a TypeScript type rather than flowing through `any`.
 */
import {
  sslCommerzHttpCall,
  SslCommerzTransportError,
} from "@/lib/sslcommerz-transport";

/**
 * The response to a session-initiation call.
 *
 * A declined session arrives with HTTP 200 and `status: "FAILED"` — the
 * HTTP status alone proves nothing, and the caller has to check
 * `status` explicitly.
 */
export interface SslCommerzInitResponse {
  readonly status?: string;
  readonly GatewayPageURL?: string;
  readonly sessionkey?: string;
  readonly tran_id?: string;
  readonly status_descriptions?: Record<string, string>;
}

/**
 * The response to a validation call.
 */
export interface SslCommerzValidationResponse {
  readonly status?: string;
  readonly tran_date?: string;
  readonly tran_id?: string;
  readonly val_id?: string;
  readonly sessionkey?: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly card_type?: string;
  readonly bank_tran_id?: string;
  readonly card_no?: string;
  readonly store_amount?: string;
  readonly risk_level?: string;
  readonly risk_title?: string;
  readonly status_descriptions?: Record<string, string>;
}

/**
 * The payment rails the gateway can settle.
 *
 * A **subset** of the shop's own `PaymentMethod` enum: `COD` is not a
 * gateway rail, because cash is collected by the courier and never
 * touches a gateway.
 */
export type SslCommerzRail = "BKASH" | "NAGAD" | "CARD";

/**
 * The rail the customer actually paid with.
 *
 * ── Why this is derived at settlement and not at checkout ────────────────
 *
 * The checkout offers one bundled "Online Payment" option, because the
 * customer picks their operator on **SSLCOMMERZ's own page** — after
 * the order has been created, and after the shop has sent them there.
 * At creation time the rail is genuinely unknown, so the order row is
 * written with the enum's generic `CARD` value.
 *
 * The gateway, however, **tells us** which rail was used. Its validation
 * response carries `card_type` — the operator's own name — and the
 * `bank_tran_id` format follows the operator too. So the rail becomes
 * knowable at the moment the payment settles, and that is exactly when
 * the order row is updated.
 *
 * So the row ends up carrying the **real** rail: a bKash order reads
 * `BKASH`, a Nagad order reads `NAGAD`, and a card order reads `CARD`.
 * The order page then renders "Paid by bKash" rather than the generic
 * "Card Payment".
 *
 * @param cardType - The gateway's `card_type` field, when it sent one.
 *
 * @returns The rail, or `null` when the gateway did not say.
 */
export function detectSslCommerzRail(
  cardType: string | undefined,
): SslCommerzRail | null {
  if (!cardType) {
    return null;
  }

  const normalized = cardType.trim().toUpperCase();

  /**
   * A blank `card_type` is "the gateway did not really say".
   *
   * It reads as a card if it is allowed through, and that is wrong:
   * `CARD` is a *write* — it replaces the order's generic method — so a
   * blank field would overwrite a rail the shop already knows with the
   * one thing we know least about. `null` says "no opinion", and the
   * order keeps what it has.
   */
  if (!normalized) {
    return null;
  }

  /**
   * The gateway spells the operators in a handful of ways.
   *
   * `card_type` is documented as "the type of card" — `VISA`,
   * `MASTERCARD`, `BKASH`, `NAGAD`, `AMEX` — but merchant
   * configurations and gateway versions differ, and the value arrives
   * free-form. So the match is on a **substring**, not an equality:
   * `BKASH`, `BKASH-WALLET` and `bKash` all find the same rail.
   */
  if (normalized.includes("BKASH")) {
    return "BKASH";
  }

  if (normalized.includes("NAGAD")) {
    return "NAGAD";
  }

  /**
   * Everything else is a card.
   *
   * Visa, Mastercard, American Express and the rest are all `CARD` as
   * far as the shop's enum is concerned — and an unrecognised value is
   * still a card payment, because a card is the only other thing the
   * gateway can take. Treating it as `null` would leave the order on
   * the generic `CARD` it already has, which is the same answer.
   */
  return "CARD";
}

/**
 * The merchant's currency.
 *
 * One constant, because "BDT" written in three places is three places to
 * forget it.
 */
export const SSLCOMMERZ_CURRENCY = "BDT";

/**
 * The product category the shop sells.
 *
 * SSLCOMMERZ requires a category on every session. "General Merchandise"
 * is the value for a shop that sells beauty products across categories.
 */
export const SSLCOMMERZ_PRODUCT_CATEGORY = "General Merchandise";

/**
 * The product profile.
 *
 * SSLCOMMERZ's profiles describe the *shape* of the purchase. A physical
 * good that is shipped is `"physical-goods"`; a digital one is
 * `"digital-goods"`. Euro Glam BD ships, so it is the physical profile.
 */
export const SSLCOMMERZ_PRODUCT_PROFILE = "physical-goods";

/**
 * The shipping method.
 *
 * The shop delivers by courier, which SSLCOMMERZ models as
 * `"Courier"`.
 */
export const SSLCOMMERZ_SHIPPING_METHOD = "Courier";

/**
 * The country the shop operates in.
 *
 * ISO 3166-1 alpha-2.
 */
export const SSLCOMMERZ_COUNTRY = "Bangladesh";

/**
 * The base URL the gateway redirects the customer back to.
 *
 * Every callback URL is built from this. It must be the **public** URL of
 * the deployment — the customer's browser resolves it, not the server, so
 * a `localhost` value sends the payment confirmation to the customer's
 * own machine.
 */
function baseUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.SITE_URL?.trim() ||
    "";

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  // The fallback is wrong in production and right in development. It is
  // used rather than throwing so that a developer running the shop
  // locally sees a working gateway session, and it is logged so the
  // mistake is visible.
  console.warn(
    "[sslcommerz] NEXT_PUBLIC_SITE_URL is not set. Falling back to " +
      "http://localhost:3000 — the callback URLs will only work locally.",
  );

  return "http://localhost:3000";
}

/**
 * The SSLCOMMERZ store configuration.
 */
export type SslCommerzConfig = {
  readonly storeId: string;
  readonly storePassword: string;
  readonly isLive: boolean;
};

/**
 * Reads the store configuration from the environment.
 *
 * @throws ApiError 503 when the credentials are missing. A missing
 *         credential is a deployment error, and failing loudly at the
 *         point of use is correct — a silent fallback would let a
 *         deployment look healthy while every payment failed.
 */
export function getSslCommerzConfig(): SslCommerzConfig {
  const storeId = process.env.SSLCOMMERZ_STORE_ID?.trim();
  const storePassword = process.env.SSLCOMMERZ_STORE_PASSWORD?.trim();

  if (!storeId || !storePassword) {
    throw new ApiError(
      "SERVICE_UNAVAILABLE",
      "The payment gateway is not configured. Set SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_PASSWORD.",
    );
  }

  // The live switch is a one-word change that must never happen by
  // accident, so it is parsed strictly: anything other than the literal
  // string "true" means sandbox. A typo therefore fails safe — it points
  // at the sandbox, where nothing can be charged — rather than failing
  // open into the live gateway.
  const isLive = process.env.SSLCOMMERZ_IS_LIVE?.trim().toLowerCase() === "true";

  return { storeId, storePassword, isLive };
}

/**
 * Whether the shop is in **sandbox** mode.
 *
 * The one place that answers it, so the answer cannot differ between
 * two call sites.
 */
export function isSslCommerzSandbox(): boolean {
  return (
    process.env.SSLCOMMERZ_IS_LIVE?.trim().toLowerCase() !== "true"
  );
}

/**
 * Whether a callback may be **trusted without the gateway's answer**.
 *
 * ── What this is ─────────────────────────────────────────────────────────
 *
 * A development aid for the shop's own sandbox testing, and **nothing
 * else**.
 *
 * The SSLCOMMERZ sandbox does not behave like the live gateway in one
 * important way: a session opened in the sandbox can come back with
 * **no validation handle**, or with a `val_id` the validation endpoint
 * does not recognise. The callback then cannot be verified, the order
 * stays `PENDING`, and the customer lands on a page that says "we could
 * not confirm the payment yet" — forever, because the sandbox will
 * never produce the answer the shop is waiting for.
 *
 * For local testing, that is an unhelpful loop. So this flag lets the
 * shop **settle a sandbox callback on the customer's own say-so**, and
 * the order moves to `PAID` and `PROCESSING` as it would in production.
 *
 * ── The guard rails ──────────────────────────────────────────────────────
 *
 * Three conditions must **all** hold, and each one is a hard stop:
 *
 *   1. The flag is explicitly enabled —
 *      `SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS=true`.
 *
 *   2. The shop is in **sandbox** — `SSLCOMMERZ_IS_LIVE` is not
 *      `"true"`. This is the important one. Even with the flag on, a
 *      live deployment never trusts an unverified callback, because a
 *      live deployment moves real money and the gateway is the only
 *      thing that can say whether it moved.
 *
 *   3. The callback names an order that **exists** and is still
 *      `PENDING`. An unverified callback can never settle an order that
 *      is already settled, and it can never create an order.
 *
 * The flag is **off** by default, and the live check is independent of
 * it — so a deployment that sets the flag carelessly still cannot
 * settle an unverified live payment.
 */
export function allowsUnverifiedCallbacks(): boolean {
  const enabled =
    process.env.SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS?.trim().toLowerCase() ===
    "true";

  if (!enabled) {
    return false;
  }

  if (!isSslCommerzSandbox()) {
    console.warn(
      "[sslcommerz] SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS is set, but the " +
        "shop is in LIVE mode. The setting is ignored — a live payment is " +
        "only ever settled by the gateway's own answer.",
    );

    return false;
  }

  return true;
}

/**
 * The customer details SSLCOMMERZ requires.
 *
 * Every field is required by the gateway, so every field is required
 * here. The types are the guard: a missing `cus_email` is a compile
 * error rather than an empty string the gateway rejects at runtime.
 */
export type SslCommerzCustomer = {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly city: string;
  readonly district: string;
  readonly postalCode: string;
};

/**
 * The product and shipping details SSLCOMMERZ requires.
 */
export type SslCommerzProduct = {
  /** The product name shown on the gateway page. */
  readonly name: string;
  /**
   * The category the product belongs to.
   *
   * Optional, and defaulted to the shop's own category constant. The
   * shop sells beauty products across categories, and a single order
   * can hold items from several of them — so there is no one category
   * that is *the* category of the order, and pretending otherwise
   * would be a fiction the gateway's own reporting would contradict.
   */
  readonly category?: string;
  /** How many units are being bought. */
  readonly quantity: number;
  /** The price of one unit, in taka. */
  readonly unitPriceTaka: number;
  /** The total, in taka. */
  readonly totalAmountTaka: number;
  /** The discount, in taka. */
  readonly discountAmountTaka?: number;
};

/**
 * The request to open a gateway session.
 */
export type SslCommerzInitiation = {
  /**
   * The merchant's own reference for this transaction.
   *
   * This is the order number — it is what the customer quotes and what
   * the shop reconciles against. SSLCOMMERZ echoes it back on every
   * callback, so it has to be unique and it has to be the order's.
   */
  readonly tranId: string;
  /** The amount, in taka. */
  readonly totalAmountTaka: number;
  /** The customer. */
  readonly customer: SslCommerzCustomer;
  /** What is being bought. */
  readonly product: SslCommerzProduct;
  /**
   * The order id, carried through as a custom value.
   *
   * SSLCOMMERZ's `value_a`/`value_b`/`value_c`/`value_d` fields are
   * round-tripped verbatim on the callback. They are how the callback
   * handler knows which order it is looking at without trusting the
   * `tran_id` alone.
   */
  readonly orderId: string;
};

/**
 * The URLs SSLCOMMERZ redirects to.
 */
export type SslCommerzCallbackUrls = {
  readonly successUrl: string;
  readonly failUrl: string;
  readonly cancelUrl: string;
  readonly ipnUrl: string;
};

/**
 * The result of opening a gateway session.
 */
export type SslCommerzSession = {
  /** Where the customer is sent to pay. */
  readonly gatewayPageUrl: string;
  /** The gateway's session key — how the transaction is validated later. */
  readonly sessionKey: string;
  /** The merchant's own reference. */
  readonly tranId: string;
};

/**
 * The raw shape of a validation response.
 *
 * The gateway answers `GET` validation calls with the transaction's
 * details, or with `status: "INVALID_TRANSACTION"` when the reference
 * does not match a real transaction.
 *
 * The declaration lives in this module now, rather than in a `.d.ts`
 * for the package — see the note at the top of the file about why the
 * package's own transport is no longer used.
 */
export type RawValidationResponse = SslCommerzValidationResponse;

/**
 * The result of validating a transaction with the gateway.
 */
export type SslCommerzValidation = {
  /** Whether the gateway recognises the transaction as valid. */
  readonly valid: boolean;
  /** The raw response, for the fields this module does not model. */
  readonly raw: RawValidationResponse;
  /** The gateway's session key, when the response carries one. */
  readonly sessionKey: string | null;
  /** The gateway's own transaction id, when the response carries one. */
  readonly bankTransactionId: string | null;
  /** The amount the gateway recorded, in taka, when it carries one. */
  readonly amountTaka: number | null;
  /** The store's reference, when the response carries one. */
  readonly tranId: string | null;
  /**
   * The rail the customer actually paid with, when the gateway said.
   *
   * This is what turns a generic `CARD` order into a `BKASH` or `NAGAD`
   * one, so the order page can say "Paid by bKash" rather than "Card
   * Payment". `null` when the gateway did not report a `card_type`.
   */
  readonly rail: SslCommerzRail | null;
};

/**
 * The gateway's endpoints.
 *
 * The package's controller hard-codes these; they are reproduced here
 * so the shop's own module owns the whole of the gateway's URL contract.
 *
 * ── The two validation endpoints are not interchangeable ──────────────────
 *
 * `validationserverAPI.php` takes a **`val_id`** — the gateway's own
 * validation handle, which it issues once a transaction is validated.
 *
 * `merchantTransIDvalidationAPI.php` takes a **`sessionkey`** or a
 * **`tran_id`** — the merchant's own references, which exist from the
 * moment the session is opened.
 *
 * They are different endpoints, not two parameter spellings for one
 * endpoint. Sending `sessionkey` to `validationserverAPI.php` does not
 * produce an error — it produces that endpoint's **SOAP API
 * documentation page**, as HTML, with HTTP 200. A caller that only
 * checked the status code would read that as a successful validation of
 * a transaction that was never checked.
 *
 * The `?` at the end of each URL is load-bearing: the parameters are
 * appended to the query string, and appending to a URL that has no `?`
 * produces a URL the gateway will not answer.
 */
function endpoints(isLive: boolean): {
  readonly init: string;
  readonly validation: string;
  readonly transactionValidation: string;
} {
  const base = isLive
    ? "https://securepay.sslcommerz.com"
    : "https://sandbox.sslcommerz.com";

  return {
    init: `${base}/gwprocess/v4/api.php`,
    validation: `${base}/validator/api/validationserverAPI.php?`,
    transactionValidation: `${base}/validator/api/merchantTransIDvalidationAPI.php?`,
  };
}

/**
 * Converts poisha to taka.
 *
 * The shop's internal unit is poisha (1 BDT = 100 poisha). SSLCOMMERZ
 * works in taka. The conversion lives here so the arithmetic exists in
 * exactly one place — a second `Math.floor(paisa / 100)` would be a
 * second thing to get wrong.
 *
 * It **rounds down** rather than to the nearest taka. Rounding up would
 * charge the customer more than the order is worth, and a shop that
 * overcharges by one taka on every order does not keep that shop.
 */
export function paisaToTaka(paisa: number): number {
  return Math.floor(paisa / 100);
}

/**
 * Builds the four callback URLs from the configured base URL.
 */
export function buildCallbackUrls(): SslCommerzCallbackUrls {
  const base = baseUrl();

  return {
    successUrl: `${base}/payment/success`,
    failUrl: `${base}/payment/fail`,
    cancelUrl: `${base}/payment/cancel`,
    ipnUrl: `${base}/payment/ipn`,
  };
}

/**
 * Calls the gateway and returns its parsed body.
 *
 * ── Why the transport's errors become `ApiError`s here ─────────────────────
 *
 * The transport throws `SslCommerzTransportError` for the failures that
 * make a call impossible — no network, an unreachable gateway. Those
 * are **not** the same thing as the gateway declining a request, and
 * the two deserve different answers:
 *
 *   • A transport failure is the shop's problem to report: the customer
 *     is told to try again, and the customer is never redirected.
 *   • A declined session is the gateway's answer, and the gateway says
 *     so in the body — `status: "FAILED"` — which the caller reads.
 *
 * So the transport error is translated into a `502` here, and the
 * response body is passed through untouched for the caller to judge.
 *
 * ── Why the return type includes `null` ────────────────────────────────────
 *
 * The transport parses the body with `JSON.parse` and keeps `null` for an
 * **empty** body. A gateway answer that is empty — a `204`, a proxy that
 * swallows the response, a sandbox that answers nothing — therefore
 * arrives here as `null`, not as an object.
 *
 * The previous version of this function cast the body to `T` and told the
 * type system it was always an object. It was not, and the lie surfaced
 * as a `TypeError: Cannot read properties of null (reading 'status')`
 * several frames away from the call that caused it — in the middle of a
 * customer's checkout, with a stack trace that pointed at the wrong
 * place entirely.
 *
 * So the type now says what is true: the body is `T` **or** `null`.
 * Every caller checks, and a missing body is treated as "the gateway
 * did not answer", which is what it is.
 *
 * @param url    - The absolute URL to call.
 * @param method - The HTTP method.
 * @param fields - The form fields to send. Omitted for `GET`.
 *
 * @throws ApiError 502 when the gateway could not be reached.
 */
async function callGateway<T>(
  url: string,
  method: "GET" | "POST",
  fields?: Record<string, string>,
): Promise<T | null> {
  try {
    const result = await sslCommerzHttpCall({
      url,
      method,
      ...(fields ? { data: fields } : {}),
    });

    return (result.body ?? null) as T | null;
  } catch (error) {
    if (error instanceof SslCommerzTransportError) {
      console.error("[sslcommerz] Gateway transport failed:", error);

      throw new ApiError(
        "BAD_GATEWAY",
        "We could not reach the payment gateway. Please try again in a moment.",
      );
    }

    throw error;
  }
}

/**
 * Narrows a gateway body to an object, or `null`.
 *
 * The gateway answers in JSON, but a JSON body is not necessarily an
 * **object** — it can be `null`, a number, a string or an array. Every
 * field this module reads lives on an object, so anything else is
 * treated as "the gateway did not answer with something usable".
 */
function asObject<T>(body: T | null): T | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  return body;
}

/**
 * Opens a gateway session and returns the URL to send the customer to.
 *
 * The parameter names are the gateway's, not ours — `total_amount`,
 * `cus_name`, `tran_id` and the rest. They are mapped here, once, so a
 * rename on the gateway's side is a one-line change in this file rather
 * than a hunt through the routes.
 *
 * @param initiation - The transaction to open a session for.
 *
 * @throws ApiError 502 when the gateway declines to open the session.
 *         The gateway answers a declined session with HTTP 200 and
 *         `status: "FAILED"`, so the status has to be checked
 *         explicitly.
 */
export async function initiatePayment(
  initiation: SslCommerzInitiation,
): Promise<SslCommerzSession> {
  const callbacks = buildCallbackUrls();

  const { storeId, storePassword, isLive } = getSslCommerzConfig();

  const { init: initUrl } = endpoints(isLive);

  /**
   * The form body.
   *
   * Every field the gateway documents, as a flat `string` map. The
   * gateway's own processor drops any field it does not recognise, so
   * the optional ones are sent empty rather than omitted — an empty
   * field and an absent field mean the same thing to it, but sending
   * the empty value keeps the shape of the request obvious against the
   * gateway's documentation.
   */
  const fields: Record<string, string> = {
    // ── The merchant's credentials ──────────────────────────────────────
    store_id: storeId,
    store_passwd: storePassword,

    // ── The merchant's reference ────────────────────────────────────────
    tran_id: initiation.tranId,

    // ── The amount ──────────────────────────────────────────────────────
    /**
     * A **string**, not a number.
     *
     * The gateway is documented to expect a decimal string here, and
     * sending a float risks a rounding artefact in the amount the
     * customer is charged. The conversion is explicit, and it happens
     * before the value leaves this module.
     */
    total_amount: initiation.totalAmountTaka.toFixed(2),
    currency: SSLCOMMERZ_CURRENCY,

    // ── The product ─────────────────────────────────────────────────────
    product_name: initiation.product.name,
    product_category: initiation.product.category ?? SSLCOMMERZ_PRODUCT_CATEGORY,
    product_profile: SSLCOMMERZ_PRODUCT_PROFILE,
    product_type: SSLCOMMERZ_PRODUCT_PROFILE,
    num_of_item: initiation.product.quantity.toString(),
    cart: initiation.product.name,
    product_amount: initiation.product.unitPriceTaka.toFixed(2),
    discount_amount: (initiation.product.discountAmountTaka ?? 0).toFixed(2),
    convenience_fee: "0.00",

    // ── The customer ────────────────────────────────────────────────────
    cus_name: initiation.customer.name,
    cus_email: initiation.customer.email,
    cus_add1: initiation.customer.addressLine1,
    cus_add2: initiation.customer.addressLine2 ?? "",
    cus_city: initiation.customer.city,
    cus_state: initiation.customer.district,
    cus_postcode: initiation.customer.postalCode,
    cus_country: SSLCOMMERZ_COUNTRY,
    cus_phone: initiation.customer.phone,

    // ── The shipment ────────────────────────────────────────────────────
    shipping_method: SSLCOMMERZ_SHIPPING_METHOD,
    ship_name: initiation.customer.name,
    ship_add1: initiation.customer.addressLine1,
    ship_add2: initiation.customer.addressLine2 ?? "",
    ship_city: initiation.customer.city,
    ship_state: initiation.customer.district,
    ship_postcode: initiation.customer.postalCode,
    ship_country: SSLCOMMERZ_COUNTRY,

    // ── The callbacks ───────────────────────────────────────────────────
    success_url: callbacks.successUrl,
    fail_url: callbacks.failUrl,
    cancel_url: callbacks.cancelUrl,
    ipn_url: callbacks.ipnUrl,

    // ── The round-trip values ───────────────────────────────────────────
    /**
     * The order id, in `value_a`.
     *
     * SSLCOMMERZ echoes the `value_*` fields back on every callback
     * untouched. That is what lets the callback handler know which order
     * it is settling without relying on the `tran_id` alone.
     */
    value_a: initiation.orderId,
    value_b: initiation.tranId,
    value_c: "",
    value_d: "",

    // ── The EMI switch ──────────────────────────────────────────────────
    emi_option: "0",
    multi_card_name: "credit-card",
  };

  const response = asObject(
    await callGateway<SslCommerzInitResponse>(initUrl, "POST", fields),
  );

  /**
   * The gateway's answer.
   *
   * A declined session comes back with HTTP 200 and `status: "FAILED"`,
   * so the HTTP status alone proves nothing. `GatewayPageURL` is the
   * field that says the session exists — and it is the field the
   * customer is about to be sent to, so a missing one is a hard failure.
   *
   * A **missing** answer is handled the same way. The gateway sent
   * nothing back — an empty body, a `null`, a proxy that swallowed the
   * response — and there is no session to send the customer to. That is
   * a failure, and it is reported as one rather than crashing on
   * `response.status`.
   */
  if (response?.status !== "SUCCESS" || !response?.GatewayPageURL) {
    const description =
      response?.status_descriptions?.[response.status ?? ""] ??
      "The payment gateway declined to open a session.";

    throw new ApiError("BAD_GATEWAY", description, {
      status: response?.status ?? null,
      tranId: initiation.tranId,
    });
  }

  return {
    gatewayPageUrl: response.GatewayPageURL,
    sessionKey: response.sessionkey ?? "",
    tranId: response.tran_id ?? initiation.tranId,
  };
}

/**
 * Validates a transaction with the gateway.
 *
 * This is the call that makes a callback **trustworthy**. The gateway
 * redirects the customer's browser to the success URL, and that browser
 * could have been edited — a customer can hand-craft a request to
 * `/payment/success?status=PAID`. So the callback handler must ask the
 * gateway whether the transaction is real, and only act on the answer.
 *
 * The `val_id` is the gateway's own validation handle, which it sends
 * with the callback.
 *
 * @param valId - The gateway's validation handle.
 */
export async function validatePayment(
  valId: string,
): Promise<SslCommerzValidation> {
  const { storeId, storePassword, isLive } = getSslCommerzConfig();

  const { validation: validationUrl } = endpoints(isLive);

  /**
   * The validation parameters go in the **query string**.
   *
   * The gateway's validation API is a `GET`, and it takes
   * `val_id`, `store_id`, `store_passwd`, `v` and `format` as URL
   * parameters rather than as a body.
   */
  const url =
    `${validationUrl}` +
    `val_id=${encodeURIComponent(valId)}` +
    `&store_id=${encodeURIComponent(storeId)}` +
    `&store_passwd=${encodeURIComponent(storePassword)}` +
    `&v=1&format=json`;

  const response = asObject(
    await callGateway<SslCommerzValidationResponse>(url, "GET"),
  );

  /**
   * A missing answer is not a valid transaction.
   *
   * The gateway sent nothing usable — an empty body, a `null`, a
   * non-object. There is no evidence the transaction happened, so there
   * is nothing to settle. The caller reads this as "not verified", which
   * is the honest reading.
   */
  if (!response) {
    console.warn(
      `[sslcommerz] Validation for val_id ${valId} returned no usable body.`,
    );

    return {
      valid: false,
      raw: {},
      sessionKey: null,
      bankTransactionId: null,
      amountTaka: null,
      tranId: null,
      rail: null,
    };
  }

  const valid = response.status === "VALID_TRANSACTION";

  return {
    valid,
    raw: response,
    sessionKey: null,
    bankTransactionId: response.bank_tran_id ?? null,
    amountTaka: response.amount ? Number(response.amount) : null,
    tranId: response.tran_id ?? null,
    rail: detectSslCommerzRail(response.card_type),
  };
}

/**
 * Looks a transaction up by the gateway's session key.
 *
 * This is the **fallback** verification path, used when a callback
 * arrives without a `val_id` — the IPN, in particular, is a server-to-
 * server call whose shape varies between gateway versions.
 *
 * @param sessionKey - The gateway's session key.
 */
export async function validatePaymentBySessionKey(
  sessionKey: string,
): Promise<SslCommerzValidation> {
  const { storeId, storePassword, isLive } = getSslCommerzConfig();

  /**
   * The **transaction** validation endpoint.
   *
   * A session key is the merchant's own handle, so it belongs on
   * `merchantTransIDvalidationAPI.php` — not on the `val_id` endpoint,
   * which answers a session key with its SOAP documentation page.
   */
  const { transactionValidation } = endpoints(isLive);

  const url =
    `${transactionValidation}` +
    `sessionkey=${encodeURIComponent(sessionKey)}` +
    `&store_id=${encodeURIComponent(storeId)}` +
    `&store_passwd=${encodeURIComponent(storePassword)}` +
    `&v=1&format=json`;

  const response = asObject(
    await callGateway<SslCommerzValidationResponse>(url, "GET"),
  );

  /**
   * A missing answer is not a valid transaction.
   *
   * Same rule as the `val_id` path above: no usable body means no
   * evidence, and no evidence means nothing is settled.
   */
  if (!response) {
    console.warn(
      `[sslcommerz] Validation for session key ${sessionKey} returned no usable body.`,
    );

    return {
      valid: false,
      raw: {},
      sessionKey: null,
      bankTransactionId: null,
      amountTaka: null,
      tranId: null,
      rail: null,
    };
  }

  const valid = response.status === "VALID_TRANSACTION";

  return {
    valid,
    raw: response,
    sessionKey: response.sessionkey ?? sessionKey,
    bankTransactionId: response.bank_tran_id ?? null,
    amountTaka: response.amount ? Number(response.amount) : null,
    tranId: response.tran_id ?? null,
    rail: detectSslCommerzRail(response.card_type),
  };
}
