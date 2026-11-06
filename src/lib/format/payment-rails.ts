/**
 * The payment rails — who the customer can pay through.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The gateway window shows a grid of providers: bKash, Nagad, Rocket,
 * Upay, Tap, and a row of banks. Most of that grid is **decorative** in
 * the strict sense — the customer cannot actually choose most of it — and
 * the rules that decide which parts are real are the kind of rule that
 * must not be scattered through a component.
 *
 * So the tables live here, in a module that **imports nothing at all**,
 * exactly as the other nine modules in `src/lib/format/` do. That is the
 * house convention, and it is not tidiness for its own sake: a pure
 * module can be imported by a client component without dragging
 * anything into the browser bundle, and it can be unit-tested without a
 * DOM.
 *
 * ── The rules this module encodes ─────────────────────────────────────────
 *
 * **1. Only bKash and Nagad are selectable.**
 *
 * The `PaymentMethod` Prisma enum is exactly `COD | BKASH | NAGAD |
 * CARD`. Rocket, Upay and Tap are real operators in Bangladesh, and the
 * shop does not hold accounts with them, so there is nothing to settle
 * a transfer against. They are shown because the reference design shows
 * them and a customer who pays by Upay should be able to see that Upay
 * is a thing this shop recognises — but they are **disabled**, with a
 * reason.
 *
 * **2. No bank is selectable.**
 *
 * Net banking is a tab that is present and clickable, and its panel is a
 * list of banks, and every one of them is disabled. There is no
 * net-banking rail in the enum, no bank-reference column, and no
 * merchant account to reconcile against. **A tab the customer can click
 * and the server cannot settle is worse than no tab** — so the tab exists
 * (the customer is not confused by a missing one) and nothing in it is
 * actionable.
 *
 * **3. The grid is a confirmation, not a control.**
 *
 * This is the important one. `settleGatewayPayment` reads
 * `order.paymentMethod` **from the database** — it never accepts a
 * method from the client. The order row is the record.
 *
 * So if this grid were a control, a customer could switch bKash to Nagad
 * inside the window, the settle would succeed, and the order row would
 * still say `BKASH`. The shop would then try to reconcile a bKash
 * transfer against a Nagad order. That is DECISIONS.md #147 — "the
 * operator must survive into the order row" — broken in a new place.
 *
 * Therefore the grid is **inert**: the rail the server recorded is
 * selected and confirmed, and the others are disabled with the reason
 * *"Not the method chosen at checkout."* The customer sees the full
 * reference-design grid and cannot desynchronise the order from its own
 * record.
 *
 * **4. An unavailable rail always explains itself.**
 *
 * A greyed-out tile with no explanation is a dead end the customer
 * cannot reason about. So `reason` is **required** on every unavailable
 * rail, and the tests enforce it.
 *
 * There are two kinds of unavailability, and they are different things to
 * the customer:
 *
 *   • **Not supported by this shop** — Rocket, Upay, Tap, and every
 *     bank. The shop simply cannot settle these.
 *   • **Not the method chosen at checkout** — the mobile rail the
 *     customer did *not* pick. This one **is** supported; it just is not
 *     this order's method. That distinction matters, and it is the
 *     reconciliation guard made visible.
 */

/**
 * Whether a rail can be used for this order.
 */
export type PaymentRailStatus = "available" | "unavailable";

/**
 * One provider in the gateway grid.
 */
export type PaymentRail = {
  /** The stable id. Matches the `PaymentMethod` for the two real rails. */
  readonly id: string;
  /** The provider's full name, as it appears beside the tile. */
  readonly label: string;
  /** The short mark drawn on the tile — "bK", "IB". */
  readonly shortLabel: string;
  /** Whether this rail can be used for this order. */
  readonly status: PaymentRailStatus;
  /**
   * Why this rail is unavailable.
   *
   * **Required** when `status` is `"unavailable"`. The tests enforce
   * that, because a disabled tile with no explanation is a dead end.
   */
  readonly reason?: string;
};

/**
 * The reason a rail is unavailable because the shop cannot settle it.
 *
 * One constant, so the wording cannot drift between the five providers
 * that share it.
 */
export const RAIL_REASON_NOT_SUPPORTED =
  "This provider is not available for this shop yet.";

/**
 * The reason a rail is unavailable because it is not this order's method.
 *
 * The reconciliation guard, in words the customer can read. It says the
 * shop *can* take this payment — just not for this order.
 */
export const RAIL_REASON_NOT_CHOSEN =
  "Not the method chosen at checkout.";

/**
 * The tabs in the gateway window.
 */
export type GatewayTabId = "cards" | "mobile" | "net";

/**
 * The tab each payment method opens on.
 *
 * `CARD` opens the cards tab; `BKASH` and `NAGAD` open the mobile
 * banking tab. Net banking has no method behind it — no enum value
 * settles against a bank — so there is no mapping for it.
 *
 * The function is **total over the gateway methods** and returns the
 * cards tab for anything it does not recognise, so a method added to
 * the enum later opens a window rather than crashing it.
 */
export function gatewayTabForMethod(method: string): GatewayTabId {
  if (method === "BKASH" || method === "NAGAD") {
    return "mobile";
  }

  return "cards";
}

/**
 * The mobile-banking providers.
 *
 * Five entries, of which **two** are available. The order is the
 * reference design's: the two real ones first, then the ones this shop
 * recognises but cannot settle.
 */
export const MOBILE_BANKING_RAILS: readonly PaymentRail[] = [
  {
    id: "BKASH",
    label: "bKash",
    shortLabel: "bK",
    status: "available",
  },
  {
    id: "NAGAD",
    label: "Nagad",
    shortLabel: "Ng",
    status: "available",
  },
  {
    id: "ROCKET",
    label: "Rocket",
    shortLabel: "Rk",
    status: "unavailable",
    reason: RAIL_REASON_NOT_SUPPORTED,
  },
  {
    id: "UPAY",
    label: "Upay",
    shortLabel: "Up",
    status: "unavailable",
    reason: RAIL_REASON_NOT_SUPPORTED,
  },
  {
    id: "TAP",
    label: "Tap",
    shortLabel: "Tp",
    status: "unavailable",
    reason: RAIL_REASON_NOT_SUPPORTED,
  },
];

/**
 * The banks.
 *
 * **Every one of them is unavailable.** The shop has no net-banking
 * rail, no bank-reference column and no merchant account to reconcile
 * against, so there is nothing behind these tiles. They are listed
 * because the reference design lists them and because a customer who
 * recognises their bank should not conclude the shop is unfamiliar with
 * banking — but not one of them is actionable.
 */
export const NET_BANKING_RAILS: readonly PaymentRail[] = [
  {
    id: "ISLAMI",
    label: "Islami Bank",
    shortLabel: "IB",
    status: "unavailable",
    reason: RAIL_REASON_NOT_SUPPORTED,
  },
  {
    id: "CITY_TOUCH",
    label: "City Touch",
    shortLabel: "CT",
    status: "unavailable",
    reason: RAIL_REASON_NOT_SUPPORTED,
  },
  {
    id: "MTB",
    label: "MTB",
    shortLabel: "MT",
    status: "unavailable",
    reason: RAIL_REASON_NOT_SUPPORTED,
  },
  {
    id: "BANK_ASIA",
    label: "Bank Asia",
    shortLabel: "BA",
    status: "unavailable",
    reason: RAIL_REASON_NOT_SUPPORTED,
  },
  {
    id: "EBL",
    label: "EBL",
    shortLabel: "EB",
    status: "unavailable",
    reason: RAIL_REASON_NOT_SUPPORTED,
  },
];

/**
 * The mobile-banking rails, resolved against a method.
 *
 * The rail the order was recorded with is `available`. The other one is
 * `unavailable` with the *"not the method chosen"* reason — which is the
 * reconciliation guard, made visible rather than merely enforced.
 *
 * For any method that is not a mobile-banking method, both rails are
 * unavailable: the customer did not choose a wallet, so neither wallet
 * is the method.
 */
export function railsForMethod(method: string): readonly PaymentRail[] {
  return MOBILE_BANKING_RAILS.map((rail) => {
    if (rail.id === method) {
      return rail;
    }

    if (rail.status === "available") {
      return {
        ...rail,
        status: "unavailable" as const,
        reason: RAIL_REASON_NOT_CHOSEN,
      };
    }

    return rail;
  });
}
