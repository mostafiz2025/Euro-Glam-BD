import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { toAuditActor } from "@/lib/admin/audit";
import { createAdminOrder } from "@/lib/admin/order-creation";
import { listAdminOrders } from "@/lib/admin/orders";
import { requireAdmin } from "@/lib/auth/guards";
import {
  adminOrderCreateSchema,
  adminOrderQuerySchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/orders
 *
 * The admin fulfilment desk.
 *
 * Query parameters (all optional):
 *
 *   status         PENDING | PROCESSING | SHIPPED | DELIVERED | CANCELLED
 *   paymentStatus  PENDING | PAID | FAILED | REFUNDED
 *   paymentMethod  COD | BKASH | NAGAD | CARD
 *   sort           newest | oldest | highest | lowest
 *   userId         filter to one customer
 *   search         matches the order number, the customer's name or email
 *   page           1-based page number
 *   limit          rows per page (max 100)
 *
 * The `counts` block reports how many orders sit in each fulfilment
 * status, each payment status and each payment method, over the whole
 * table rather than the filtered page — so an admin can see "14 pending"
 * and navigate to them even while looking at a filtered list.
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = adminOrderQuerySchema.parse(rawQuery);

    const result = await listAdminOrders(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/admin/orders
 *
 * Places an order on the shop's behalf — a phone order, or a
 * replacement for a returned parcel.
 *
 * Body:
 *
 * ```json
 * {
 *   "userId": "ckq1example0000000000abc",
 *   "fullName": "Ayesha Rahman",
 *   "phone": "01712345678",
 *   "addressLine1": "House 12, Road 5, Dhanmondi",
 *   "city": "Dhaka",
 *   "district": "Dhaka",
 *   "postalCode": "1209",
 *   "paymentMethod": "COD",
 *   "lines": [{ "productId": "ckq1example0000000000abc", "quantity": 2 }],
 *   "reason": "Phone order — customer called to place it directly."
 * }
 * ```
 *
 * ### The body carries no prices
 *
 * There is no price, total or amount field, and none is accepted. The
 * prices are read from the product rows inside the transaction and the
 * totals are computed from them — the same rules the customer checkout
 * uses. An admin's browser is exactly as capable of being tampered with
 * as a customer's.
 *
 * ### The customer must exist
 *
 * The order is attributed to a real customer account, so the customer
 * can see it in their own order history. Creating a user as a side
 * effect of creating an order would need a password policy and an
 * email-verification story that does not belong here.
 *
 * ### The transaction
 *
 * The order, its items, the stock decrements and the notification all
 * happen in one interactive transaction. The stock decrement is a
 * conditional write, so two concurrent orders cannot sell the same unit
 * twice.
 *
 * Admin only.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const admin = await requireAdmin();

    const body = adminOrderCreateSchema.parse(await request.json());

    const order = await createAdminOrder(toAuditActor(admin), body);

    return ok({ order }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
