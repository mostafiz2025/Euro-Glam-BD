import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { listOrders, placeOrder } from "@/lib/orders/service";
import { checkoutSchema } from "@/lib/validation/commerce";

/**
 * GET /api/orders
 *
 * The signed-in customer's order history, newest first.
 *
 * Query parameters: `page` (default 1) and `limit` (default 20).
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    const user = await requireCustomer();

    const url = new URL(request.url);

    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const limit = Number.parseInt(
      url.searchParams.get("limit") ?? "20",
      10,
    );

    const safePage = Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1;
    const safeLimit =
      Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;

    const result = await listOrders(user.id, safePage, safeLimit);

    return ok({
      orders: result.orders,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / safeLimit)),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/orders
 *
 * Places an order from the current cart.
 *
 * Body:
 * ```json
 * {
 *   "shippingAddress": {
 *     "fullName": "Ayesha Rahman",
 *     "phone": "01712345678",
 *     "addressLine1": "House 12, Road 5, Dhanmondi",
 *     "city": "Dhaka",
 *     "district": "Dhaka",
 *     "postalCode": "1209"
 *   },
 *   "paymentMethod": "COD",
 *   "confirmConflicts": false
 * }
 * ```
 *
 * ### The body carries no prices
 *
 * There is no price, total or amount field, and none is accepted. Every
 * figure in the order is computed server-side from the product rows read
 * inside the transaction. A client-supplied price is a vulnerability, not
 * a convenience.
 *
 * ### The transaction
 *
 * The order, its items, the stock decrements and the cart emptying all
 * happen in one interactive transaction. Either all of it happens or none
 * of it does. The stock decrement is a conditional write, so two
 * concurrent checkouts can never sell the same unit twice.
 *
 * ### The conflict check
 *
 * The cart's ingredient conflicts are re-evaluated inside the transaction.
 * If a `BLOCK` conflict is present and `confirmConflicts` is not `true`,
 * the order is refused with a 409 that carries the conflict details and
 * the remedy. The customer reads it, decides, and confirms.
 *
 * ### Payment
 *
 * Four methods are accepted: `COD`, `BKASH`, `NAGAD` and `CARD`. The
 * chosen one is stored on the order as `paymentMethod`.
 *
 * `BKASH` and `NAGAD` are settled by a transfer the customer makes
 * **before** the order ships, so the body must also carry the two
 * references the shop needs to reconcile that transfer:
 *
 * ```json
 * {
 *   "paymentMethod": "BKASH",
 *   "paymentSenderNumber": "01712345678",
 *   "paymentTransactionId": "8N3F2K9LM4"
 * }
 * ```
 *
 * Both are **required** for a mobile-banking order and **refused** for a
 * `COD` or `CARD` order. The refusal matters: a stray transaction
 * reference on a cash order would be a record of a transfer that does
 * not exist.
 *
 * The sender number is stored in the local `01XXXXXXXXX` form — the
 * format bKash and Nagad display in a merchant statement — so the admin
 * can find the transfer by the number that actually appears on it.
 *
 * Every method starts as `PENDING` for both the order status and the
 * payment status. A customer *telling* us they sent a transfer is not
 * the same as the money having arrived; an admin confirms it against
 * the merchant statement and moves the payment to `PAID`.
 *
 * ### The gateway's own rail
 *
 * `CARD` here does **not** mean "a card". It means "online payment",
 * and it is deliberately the generic value — because at checkout time
 * the shop genuinely does not know.
 *
 * The checkout offers one "Online Payment" option that bundles bKash,
 * Nagad and cards, and the customer picks the operator **on the
 * gateway's own page**, which happens *after* this request and *after*
 * the order row exists. There is no body field that could carry the
 * choice, because the choice has not been made yet.
 *
 * So the rail is discovered where it becomes knowable: the gateway's
 * validation response names the method it actually used, and the
 * settlement handler writes that onto the order — replacing the
 * generic `CARD` with `BKASH`, `NAGAD`, or leaving `CARD` for a real
 * card. The order page's badge then reads "Paid by bKash" or "Paid by
 * Nagad" instead of "Card Payment".
 *
 * A client **cannot** shortcut this by posting `paymentMethod:
 * "BKASH"` with a gateway order and no transfer references — those
 * references are required, and an order carrying them is settled by
 * hand rather than by the gateway.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireCustomer();

    const body = checkoutSchema.parse(await request.json());

    const order = await placeOrder(user.id, body);

    return ok({ order }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
