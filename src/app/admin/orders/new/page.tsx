import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AdminOrderCreateForm } from "@/components/admin/orders/AdminOrderCreateForm";
import { AdminErrorState } from "@/components/admin/primitives";
import { listAdminUsers } from "@/lib/admin/users";
import { db } from "@/lib/db";

/**
 * The admin order creation page.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * The two cases a checkout cannot cover:
 *
 *   1. A **phone order** — a customer rings the shop and asks to pay on
 *      delivery, with no cart because they never added anything.
 *
 *   2. A **replacement order** — a courier returns a damaged parcel and
 *      the shop sends a new one, but the customer is not sitting at a
 *      computer.
 *
 * ── Why the customer must already exist ──────────────────────────────────
 *
 * The order's `userId` is a foreign key to `User`. Creating a user as a
 * side effect of creating an order would need a password policy and an
 * email-verification story, and none of that belongs in the fulfilment
 * desk. So the form lists the shop's existing customers, and the
 * service refuses an unknown id.
 *
 * The list is deliberately **bounded** — the two hundred
 * most-recently-active customers — because a dropdown of ten thousand
 * accounts is not a usable control, and an admin who cannot find the
 * customer can create the order from their order page instead.
 */
export const metadata: Metadata = {
  title: "New order",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

/**
 * The new-order page.
 */
export default async function AdminNewOrderPage() {
  await connection();

  const [customers, products] = await Promise.all([
    loadCustomers(),
    loadProducts(),
  ]);

  if (!customers || !products) {
    return (
      <>
        <PageHeading
          title="New order"
          description="Place an order on the shop's behalf."
        />

        <AdminErrorState message="We could not load the customers and products. Please try again in a moment." />
      </>
    );
  }

  return (
    <>
      <PageHeading
        title="New order"
        description="Place an order on the shop's behalf — a phone order, or a replacement for a returned parcel."
      />

      <AdminOrderCreateForm customers={customers} products={products} />
    </>
  );
}

/**
 * Loads the customers the form offers.
 *
 * The two hundred most recently active accounts. The list is ordered by
 * the most recent order, so the customer an admin is ringing is near
 * the top.
 */
async function loadCustomers() {
  try {
    const result = await listAdminUsers({ page: 1, limit: 100 });

    return result.users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
    }));
  } catch (error) {
    console.error("[admin] Customer list failed:", error);
    return null;
  }
}

/**
 * Loads the products the form offers.
 *
 * The two hundred most recently updated products that are on sale. The
 * archived ones are excluded — a withdrawn product cannot be ordered.
 */
async function loadProducts() {
  try {
    const rows = await db.product.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        pricePaisa: true,
        discountPricePaisa: true,
        stockQuantity: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      pricePaisa: row.pricePaisa,
      discountPricePaisa: row.discountPricePaisa,
      stockQuantity: row.stockQuantity,
    }));
  } catch (error) {
    console.error("[admin] Product list failed:", error);
    return null;
  }
}

/**
 * The page heading, with a way back.
 */
function PageHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="mb-6">
      <Link
        href="/admin/orders"
        className="inline-flex items-center gap-1 text-xs font-medium text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
      >
        ← Back to orders
      </Link>

      <h1 className="mt-2 font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>

      <p className="mt-1.5 text-sm text-foreground-muted">{description}</p>
    </div>
  );
}
