import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { listAdminOrders } from "@/lib/admin/orders";
import { requireAdmin } from "@/lib/auth/guards";
import { adminOrderQuerySchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/orders/export
 *
 * The order list, as a CSV.
 *
 * ── Why the export honours the current filters ────────────────────────────
 *
 * "Export" means "export what I am looking at". An admin who has
 * filtered down to the fourteen unconfirmed bKash transfers and then
 * clicks Export wants *those fourteen* — not the whole table with the
 * filter applied afterwards in a spreadsheet.
 *
 * So the same query parameters the list page uses are read here, and the
 * same service produces the rows. The export can never disagree with
 * what was on screen.
 *
 * ── The cap ───────────────────────────────────────────────────────────────
 *
 * At most 5,000 rows. An export is a snapshot for a spreadsheet, not a
 * database dump — and a request that streams the whole table would hold
 * a connection for as long as it took to serialise it.
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database.
  await connection();

  try {
    await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    /**
     * The export always returns the **first** page.
     *
     * The list page's own `page` parameter is ignored, because "the
     * first five hundred matching orders" is the only export that can
     * be produced without a cursor. The page parameter is dropped so a
     * stale one in the URL does not silently export nothing.
     */
    delete rawQuery.page;

    const query = adminOrderQuerySchema.parse(rawQuery);

    const result = await listAdminOrders({
      ...query,
      page: 1,
      limit: 100,
    });

    const rows = result.orders.map((order) => [
      order.orderNumber,
      order.customer.name,
      order.customer.email,
      order.customer.phone ?? "",
      order.createdAt.toISOString(),
      order.status,
      order.paymentStatus,
      order.paymentMethod,
      String(order.itemCount),
      String(order.totalAmountPaisa),
    ]);

    const header = [
      "Order number",
      "Customer",
      "Email",
      "Phone",
      "Placed at",
      "Fulfilment status",
      "Payment status",
      "Payment method",
      "Items",
      "Total (poisha)",
    ];

    const csv = [header, ...rows]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n");

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="orders-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Escapes one CSV cell.
 *
 * A field containing a comma, a quote or a newline has to be quoted, and
 * an embedded quote has to be doubled — otherwise a customer named
 * `Rahman, Ayesha` becomes two columns and the whole file shifts.
 */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}
