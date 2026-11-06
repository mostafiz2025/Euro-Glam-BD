import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { trackOrder } from "@/lib/orders/tracking";
import { orderTrackingSchema } from "@/lib/validation/tracking";

/**
 * POST /api/order-tracking
 *
 * The guest order-tracking endpoint.
 *
 * ── Why this route is public ──────────────────────────────────────────────
 *
 * It is the **whole point** of the page. The customer who most needs to
 * know where their parcel is — the one who ordered as a guest, or who
 * never made an account — is by definition not signed in. A session
 * requirement would make the endpoint answer only to customers who do
 * not need it.
 *
 * So it is public, and it is protected by something else entirely: the
 * **contact detail**. The caller must supply the email address or the
 * phone number that is on the order. That is a secret the customer
 * holds and an attacker does not.
 *
 * ── Why the path is not `/api/track` ──────────────────────────────────────
 *
 * `/api/track` is the **traffic beacon** — the storefront's analytics
 * ping. It is a different thing entirely, it has been there since the
 * traffic work, and reusing it would mean two unrelated endpoints
 * fighting over one path with two unrelated contracts.
 *
 * So this route is `/api/order-tracking`, which says what it does.
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 * **1. The body carries an order number and a contact detail, and
 * nothing else.**
 *
 * No email override, no phone override, no "skip the check". The
 * contact detail is compared against what is on the order, and the
 * comparison happens on the server, where the client cannot influence
 * it.
 *
 * **2. A failure is a `404`, and it is the same `404` for every
 * failure.**
 *
 * A mistyped order number, a number that was never issued, and a
 * correct number with the wrong contact detail all produce the same
 * answer. If they produced different answers, the endpoint would be an
 * enumeration oracle over the shop's order numbers.
 *
 * **3. The limit is enforced before the lookup.**
 *
 * The cap is a cost imposed on the *attempt*, so it is read before the
 * work is done. Checking it afterwards would hand the attacker their
 * guesses for free.
 *
 * **4. The response carries only what a tracking page needs.**
 *
 * The status, the total, the items and the order number. Not the
 * payment transaction ids, not the gateway handles, not the delivery
 * notes — a customer tracking a parcel does not need the courier's
 * instructions, and every column returned is a column that could leak.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the database on every
  // request. `connection()` MUST be called outside the try block: its
  // rejection is the signal that aborts prerendering.
  await connection();

  try {
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    const input = orderTrackingSchema.parse(body);

    const order = await trackOrder(input.orderNumber, input.contact);

    /*
     * The single negative answer.
     *
     * The message says what the customer should do next rather than
     * what went wrong internally, and it names both things they might
     * have got wrong — because the customer genuinely cannot tell which
     * one it was, and the message is the same for all of them.
     */
    if (!order) {
      throw ApiError.notFound(
        "We could not find an order matching that number and contact detail. Please check both and try again.",
      );
    }

    return ok({ order });
  } catch (error) {
    return handleApiError(error);
  }
}
