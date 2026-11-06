import {
  AdminNotificationKind,
  PaymentMethod,
  Prisma,
} from "@prisma/client";

import { db } from "@/lib/db";

/**
 * The admin notification inbox.
 *
 * ── What this service is ──────────────────────────────────────────────────
 *
 * The shop's order desk needs to know the moment an order arrives. The
 * customer places it; the admin is somewhere else — on another page, or
 * away from the desk — and the order sits unnoticed until they happen
 * to open the orders list.
 *
 * So a customer placing an order writes a **notification row**, and the
 * admin's bell polls for them.
 *
 * ── The rules that govern this file ───────────────────────────────────────
 *
 * **1. A notification is written in the same transaction as the order.**
 *
 * The same rule the audit log obeys, for the same reason. An order with
 * no notification is an order the admin may never see, and an order that
 * exists but was never announced looks exactly like an order that was
 * never placed.
 *
 * So `createNotification` takes a `TransactionClient`, and there is
 * deliberately **no overload that takes the root `db` client** — writing
 * a notification outside the order's transaction is awkward by
 * construction rather than by convention.
 *
 * **2. The notification is not the source of truth.**
 *
 * The order row is. The notification is a **pointer** to an event: it
 * says "an order happened", and carries just enough to render a sentence
 * without a join. If a notification were the record of the order, the
 * two could disagree — and they would, the first time an order was
 * edited.
 *
 * That is why the denormalised fields (`orderNumber`, `customerName`,
 * `totalAmountPaisa`, `paymentMethod`) are a **snapshot** taken when the
 * notification was written, and not a live link. They are what the bell
 * shows; they are not what the order page shows.
 *
 * **3. Unread is per notification, not a watermark.**
 *
 * See the migration's note. A `read` boolean per row is the cheapest
 * possible answer to the only question the badge asks: "how many have I
 * not seen?"
 *
 * **4. Reading a notification is not a mutation of the order.**
 *
 * Marking a notification read changes nothing about the order, the
 * customer, or the money. So it does not write an audit entry — the
 * audit trail is for decisions that change the business, and "the admin
 * glanced at a toast" is not one of them. Writing an entry for every
 * read would bury the entries that matter under a flood of noise.
 */

/**
 * The notification shape the browser holds.
 */
export type AdminNotificationView = {
  readonly id: string;
  readonly kind: AdminNotificationKind;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly totalAmountPaisa: number;
  readonly paymentMethod: PaymentMethod;
  readonly read: boolean;
  readonly createdAt: Date;
};

/**
 * The Prisma client type an interactive transaction receives.
 */
export type NotificationTransactionClient = Prisma.TransactionClient;

/**
 * The fields a notification is written from.
 *
 * A narrow shape rather than a whole order row — the writer only needs
 * the identity and the four figures the bell renders.
 */
export type NotificationInput = {
  readonly kind: AdminNotificationKind;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly totalAmountPaisa: number;
  readonly paymentMethod: PaymentMethod;
};

/**
 * Projects a notification row onto the view shape.
 */
function toView(
  row: Prisma.AdminNotificationGetPayload<Record<string, never>>,
): AdminNotificationView {
  return {
    id: row.id,
    kind: row.kind,
    orderId: row.entityId,
    orderNumber: row.orderNumber,
    customerName: row.customerName,
    totalAmountPaisa: row.totalAmountPaisa,
    paymentMethod: row.paymentMethod,
    read: row.read,
    createdAt: row.createdAt,
  };
}

/**
 * Writes a notification.
 *
 * **Must be called inside the transaction that made the change.**
 *
 * @param tx   - The transaction the change was made in.
 * @param input - What the admin is being told about.
 */
export async function createNotification(
  tx: NotificationTransactionClient,
  input: NotificationInput,
): Promise<AdminNotificationView> {
  const row = await tx.adminNotification.create({
    data: {
      kind: input.kind,
      entityId: input.orderId,
      orderNumber: input.orderNumber,
      customerName: input.customerName,
      totalAmountPaisa: input.totalAmountPaisa,
      paymentMethod: input.paymentMethod,
    },
  });

  return toView(row);
}

/**
 * The most recent notifications, newest first.
 *
 * The unread ones are included — the bell shows both, with the unread
 * ones marked — because an admin who opens the bell wants to see what
 * they have *and* have not seen.
 *
 * @param limit - The most rows to return. Bounded, because this runs
 *        on a poll and an unbounded query would be an unbounded
 *        response.
 */
export async function listNotifications(
  limit = 20,
): Promise<AdminNotificationView[]> {
  const rows = await db.adminNotification.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
  });

  return rows.map(toView);
}

/**
 * The number of notifications the admin has not seen.
 *
 * This is the badge's number, and it is a `count` rather than a
 * `findMany` — the bell only needs the number, and counting rows is
 * cheaper than reading them.
 */
export async function countUnreadNotifications(): Promise<number> {
  return db.adminNotification.count({ where: { read: false } });
}

/**
 * Marks a notification as read.
 *
 * Returns the updated notification, or `null` when the id does not
 * exist. A `null` is not an error: the admin may have dismissed a toast
 * whose row was already cleaned up, and refusing the request would
 * make the bell's optimistic update fail for no reason.
 */
export async function markNotificationRead(
  notificationId: string,
): Promise<AdminNotificationView | null> {
  const row = await db.adminNotification.updateMany({
    where: { id: notificationId },
    data: { read: true },
  });

  if (row.count === 0) {
    return null;
  }

  const updated = await db.adminNotification.findUnique({
    where: { id: notificationId },
  });

  return updated ? toView(updated) : null;
}

/**
 * Marks every notification as read.
 *
 * The "mark all read" action. It is **not** an audit entry — see rule 4
 * above.
 */
export async function markAllNotificationsRead(): Promise<number> {
  const result = await db.adminNotification.updateMany({
    where: { read: false },
    data: { read: true },
  });

  return result.count;
}
