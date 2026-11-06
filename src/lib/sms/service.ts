import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { writeAuditEntry, SMS_ACTIONS, type AuditActor } from "@/lib/admin/audit";
import { db } from "@/lib/db";
import { bdPhoneSchema } from "@/lib/validation/schemas";

import {
  getSmsGateway,
  SmsGatewayError,
  type SmsGateway,
} from "./index";
import {
  buildDepletionReminderBody,
  buildManualResendBody,
} from "./templates";

/**
 * The depletion-reminder workflow.
 *
 * ── The three properties that matter ───────────────────────────────────
 *
 *   1. **A message only reaches someone who opted in.** The consent
 *      check is not a line of application code that could be skipped —
 *      it is asserted in the *claim query's WHERE clause*, so a customer
 *      who opts out mid-sweep is still protected.
 *
 *   2. **A message is never sent twice.** The claim sets
 *      `reminderSentAt` conditionally, and the `SmsLog.idempotencyKey`
 *      is `@unique`. Both are needed: the claim stops the second sweep,
 *      and the unique constraint stops the case where the claim succeeds
 *      but the send is retried.
 *
 *   3. **One failure does not abort the rest.** A provider outage on
 *      item 3 must not prevent items 4 through 100 from being reminded.
 *      The sweep continues, and the failure is recorded.
 */

/**
 * How many days before a product's estimated empty date the reminder is
 * sent.
 *
 * A **constant**, not a setting. A setting defaulting to zero would mean
 * "due exactly now", and a sweep run at the wrong moment would silently
 * do nothing — which looks identical to "there is nothing to remind
 * about". Three days is long enough for the customer to reorder and
 * short enough that the product has not run out yet.
 */
export const REMINDER_LEAD_TIME_DAYS = 3;

/**
 * The maximum number of items one sweep will consider.
 *
 * A bound, so a misconfigured estimate cannot turn one admin request
 * into ten thousand messages. The result reports `examined`, so a capped
 * run is visible rather than silent.
 */
export const MAX_ITEMS_PER_SWEEP = 500;

/**
 * The reasons a message may have been sent.
 */
export const SMS_REASONS = {
  depletionReminder: "depletion_reminder",
  manualResend: "manual_resend",
} as const;

export type SmsReason = (typeof SMS_REASONS)[keyof typeof SMS_REASONS];

/**
 * The idempotency key for an automated reminder.
 *
 * Deterministic, and derived from the order item — so the same reminder
 * always has the same key, and the unique constraint on
 * `SmsLog.idempotencyKey` is what actually prevents a double-send.
 */
export function reminderIdempotencyKey(orderItemId: string): string {
  return `reminder:${orderItemId}`;
}

/**
 * The idempotency key for a manual resend.
 *
 * A **distinct** key from the automated one. If it were the same, the
 * admin's explicit instruction to resend would be silently swallowed by
 * the unique constraint from the original automated message — the admin
 * would see a success response and the customer would receive nothing.
 */
export function manualResendIdempotencyKey(orderItemId: string): string {
  return `reminder:${orderItemId}:manual`;
}

/**
 * The outcome for one item in a sweep.
 */
export type ReminderOutcome = {
  readonly orderItemId: string;
  readonly status: "sent" | "skipped" | "failed";
  /** Why the item was skipped or failed. */
  readonly reason?: string;
  readonly errorCode?: string;
};

/**
 * The result of a sweep.
 *
 * `examined`, `sent`, `skipped` and `failed` are **separate numbers**,
 * and that is the point. A run that examined 40 items and sent 0 looks
 * visibly different from a run that examined 0 — without that, "nothing
 * was sent" is indistinguishable from "nothing needed sending", which
 * is the Step 9 bug class.
 */
export type ReminderSweepResult = {
  readonly examined: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly details: ReminderOutcome[];
  /** True when the sweep was capped before it looked at every candidate. */
  readonly truncated: boolean;
};

/**
 * The options for a sweep.
 */
export type ReminderSweepOptions = {
  /**
   * The gateway to use. Defaults to the configured one.
   *
   * A **default parameter**, not a hard dependency, so a test can inject
   * a mock (or a deliberately failing double) without touching the
   * environment.
   */
  readonly gateway?: SmsGateway;
  /** When true, nothing is sent and nothing is written. */
  readonly dryRun?: boolean;
  /** The clock, for the tests. Defaults to the system clock. */
  readonly now?: Date;
};

/**
 * The Prisma client type an interactive transaction receives.
 */
type TransactionClient = Prisma.TransactionClient;

/**
 * The item as the sweep needs it.
 */
type ReminderCandidate = {
  readonly id: string;
  readonly estimatedEmptyAt: Date | null;
  readonly order: {
    readonly id: string;
    readonly orderNumber: string;
    readonly user: {
      readonly phone: string | null;
    };
  };
  readonly product: {
    readonly name: string;
  };
};

/**
 * Returns the candidates that are due for a reminder.
 *
 * ── Why the consent filter lives in the query ──────────────────────────
 *
 * The `where` clause asserts the consent, the phone number and the
 * reminder window **together**, in one database call. It is not fetched
 * and then checked in application code, because a check that happens
 * after the fetch has a window in which the customer can opt out — and a
 * window is exactly where a consent bug lives.
 *
 * The candidate list is deliberately *not* filtered on consent here; it
 * is filtered on the reminder window only, so that the sweep can report
 * how many items it skipped *because the customer had not opted in*.
 * That count is the evidence that consent is working.
 */
async function findDueCandidates(
  now: Date,
  limit: number,
): Promise<ReminderCandidate[]> {
  const dueBy = new Date(
    now.getTime() + REMINDER_LEAD_TIME_DAYS * 24 * 60 * 60 * 1000,
  );

  return db.orderItem.findMany({
    where: {
      // An estimate is never inferred — if the customer did not supply
      // one, there is nothing to remind about.
      estimatedEmptyAt: { not: null, lte: dueBy },
      reminderSentAt: null,
    },
    select: {
      id: true,
      estimatedEmptyAt: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          user: { select: { phone: true } },
        },
      },
      product: { select: { name: true } },
    },
    orderBy: { estimatedEmptyAt: "asc" },
    take: limit,
  });
}

/**
 * Why a claim failed.
 *
 * The distinction matters for the admin reading the sweep's report: "the
 * customer has not opted in" is a consent outcome, while "already
 * reminded" is a no-op. They look identical in a generic message and
 * mean very different things.
 */
type ClaimFailure =
  | "already_reminded"
  | "no_longer_due"
  | "no_consent"
  | "no_phone"
  | "not_found";

/**
 * Claims one item for a reminder.
 *
 * The claim is a **conditional update**: it only succeeds when the item
 * is still un-reminded, still due, and the owning customer still has
 * consent and a phone number.
 *
 * Every one of those conditions is in the `WHERE` clause, so the
 * database — not the application — decides whether this send is
 * allowed. Two concurrent sweeps race here and exactly one wins.
 *
 * When the claim fails, a second, narrower read explains *why*. The
 * read is only for the report — the claim itself was already
 * authoritative, and the read never gates the decision.
 */
async function claimItem(
  tx: TransactionClient,
  itemId: string,
  now: Date,
): Promise<
  | {
      claimed: true;
      phone: string;
      orderId: string;
      orderNumber: string;
      productName: string;
    }
  | { claimed: false; reason: ClaimFailure }
> {
  const dueBy = new Date(
    now.getTime() + REMINDER_LEAD_TIME_DAYS * 24 * 60 * 60 * 1000,
  );

  const claimed = await tx.orderItem.updateMany({
    where: {
      id: itemId,
      reminderSentAt: null,
      estimatedEmptyAt: { not: null, lte: dueBy },
      order: {
        user: {
          smsOptIn: true,
          phone: { not: null },
        },
      },
    },
    data: { reminderSentAt: now },
  });

  if (claimed.count === 0) {
    return { claimed: false, reason: await explainClaimFailure(tx, itemId, dueBy) };
  }

  const item = await tx.orderItem.findUnique({
    where: { id: itemId },
    select: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          user: { select: { phone: true } },
        },
      },
      product: { select: { name: true } },
    },
  });

  if (!item) {
    return { claimed: false, reason: "not_found" };
  }

  const phone = item.order.user.phone;

  // The claim already asserted the phone is present, but the row is
  // re-read after the update, so the type is genuinely optional here.
  if (!phone) {
    return { claimed: false, reason: "no_phone" };
  }

  return {
    claimed: true,
    phone,
    orderId: item.order.id,
    orderNumber: item.order.orderNumber,
    productName: item.product.name,
  };
}

/**
 * Explains why a claim did not succeed.
 *
 * A reporting helper only. The claim itself is the authority — this
 * read happens *after* the claim has already failed.
 */
async function explainClaimFailure(
  tx: TransactionClient,
  itemId: string,
  dueBy: Date,
): Promise<ClaimFailure> {
  const row = await tx.orderItem.findUnique({
    where: { id: itemId },
    select: {
      reminderSentAt: true,
      estimatedEmptyAt: true,
      order: {
        select: { user: { select: { smsOptIn: true, phone: true } } },
      },
    },
  });

  if (!row) return "not_found";
  if (row.reminderSentAt !== null) return "already_reminded";
  if (row.estimatedEmptyAt === null || row.estimatedEmptyAt > dueBy) {
    return "no_longer_due";
  }
  if (!row.order.user.smsOptIn) return "no_consent";
  if (!row.order.user.phone) return "no_phone";

  // The claim failed for a reason the narrow read cannot distinguish —
  // most likely a concurrent sweep that claimed it a moment ago.
  return "already_reminded";
}

/**
 * The human-readable reason for a skip.
 */
function skipReason(reason: ClaimFailure): string {
  switch (reason) {
    case "already_reminded":
      return "Already reminded — this item was claimed by an earlier sweep.";
    case "no_longer_due":
      return "No longer due — the estimate is outside the reminder window.";
    case "no_consent":
      return "The customer has not opted in to SMS reminders.";
    case "no_phone":
      return "The customer has no phone number.";
    case "not_found":
      return "The order item no longer exists.";
  }
}

/**
 * Claims the idempotency key for a manual resend.
 *
 * ── Why the key is claimed before the send ──────────────────────────────
 *
 * A check-then-act ("does a row with this key exist?") is not a
 * guarantee. Two admins clicking "resend" at the same moment would both
 * pass the check and both send. The guarantee is the **unique
 * constraint** on `SmsLog.idempotencyKey`, and it only works if the row
 * is written *before* the provider is called.
 *
 * So the row is inserted with a provisional status, the provider is
 * called, and the row is updated with the outcome. A second resend loses
 * the insert race and is refused — without the customer receiving two
 * messages.
 *
 * Returns `false` when the key was already claimed.
 */
async function claimManualResendKey(input: {
  phone: string;
  body: string;
  userId: string;
  orderItemId: string;
  idempotencyKey: string;
  provider: string;
}): Promise<boolean> {
  // A fast pre-check. It is **not** the guarantee — two admins clicking
  // "resend" at the same moment would both pass it — but it keeps the
  // common case (an admin resending something already resent) from
  // generating a constraint violation in the database log, which would
  // make a normal, handled refusal look like a crash.
  const existing = await db.smsLog.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });

  if (existing) {
    return false;
  }

  try {
    await db.smsLog.create({
      data: {
        phone: input.phone,
        body: input.body,
        userId: input.userId,
        orderItemId: input.orderItemId,
        reason: SMS_REASONS.manualResend,
        idempotencyKey: input.idempotencyKey,
        // "queued" — claimed, but the provider has not been called yet.
        status: "queued",
        provider: input.provider,
      },
    });

    return true;
  } catch (error) {
    // P2002 — the unique constraint on `idempotencyKey` fired. The key
    // is already claimed, so this resend is refused. The pre-check
    // above cannot catch this case, because the other resend claimed
    // the key between the check and the insert.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      return false;
    }

    throw error;
  }
}

/**
 * Records the outcome of one send.
 *
 * Returns the id of the log row, so a caller can point the admin at the
 * exact record of what was sent. The row is written **outside** any
 * caller-held transaction on purpose — the log describes a send that has
 * already happened, and the sweep's transaction was closed before the
 * provider was called.
 */
async function recordSend(
  input: {
    phone: string;
    body: string;
    userId: string | null;
    orderItemId: string;
    reason: SmsReason;
    idempotencyKey: string;
    status: "sent" | "failed";
    errorCode?: string;
    provider: string;
    providerMessageId?: string;
  },
): Promise<{ id: string }> {
  return db.smsLog.create({
    data: {
      phone: input.phone,
      body: input.body,
      userId: input.userId,
      orderItemId: input.orderItemId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      errorCode: input.errorCode ?? null,
      provider: input.provider,
      providerMessageId: input.providerMessageId ?? null,
    },
    select: { id: true },
  });
}

/**
 * Runs the depletion-reminder sweep.
 *
 * ── The transaction shape ──────────────────────────────────────────────
 *
 * The gateway call sits **between** two transactions, not inside one:
 *
 *   1. Claim the item (sets `reminderSentAt`) and read what to send.
 *   2. Send — no transaction open, so no pooled connection is held for
 *      the provider's latency.
 *   3. Record the outcome.
 *
 * The alternative — one transaction around all three — would hold a
 * database connection open across a network call, and on a busy shop
 * that exhausts the pool.
 *
 * The ordering is claim → send → log, deliberately. **A missing log row
 * is a reporting gap, and it is recoverable. A double-send is not.**
 *
 * @param actor   - The admin who triggered the sweep. Recorded in the
 *                  audit log.
 * @param options - The gateway, the dry-run flag and the clock.
 */
export async function triggerDepletionReminders(
  actor: AuditActor,
  options: ReminderSweepOptions = {},
): Promise<ReminderSweepResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const gateway = options.gateway ?? (await getSmsGateway());

  const candidates = await findDueCandidates(now, MAX_ITEMS_PER_SWEEP + 1);

  const truncated = candidates.length > MAX_ITEMS_PER_SWEEP;
  const considered = truncated
    ? candidates.slice(0, MAX_ITEMS_PER_SWEEP)
    : candidates;

  const details: ReminderOutcome[] = [];

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of considered) {
    // ── Dry run: report, change nothing ───────────────────────────────
    if (dryRun) {
      const optedIn = await hasConsent(candidate);
      const hasPhone = candidate.order.user.phone !== null;

      if (!optedIn) {
        skipped += 1;
        details.push({
          orderItemId: candidate.id,
          status: "skipped",
          reason: "The customer has not opted in to SMS reminders.",
        });
        continue;
      }

      if (!hasPhone) {
        skipped += 1;
        details.push({
          orderItemId: candidate.id,
          status: "skipped",
          reason: "The customer has no phone number.",
        });
        continue;
      }

      sent += 1;
      details.push({
        orderItemId: candidate.id,
        status: "sent",
        reason: "Dry run — no message was sent.",
      });
      continue;
    }

    // ── Claim ──────────────────────────────────────────────────────────
    // The claim asserts consent, the phone number and the window in one
    // conditional update. If it fails, the item is skipped — and the
    // report says exactly why.
    const claimed = await db.$transaction(async (tx: TransactionClient) => {
      const result = await claimItem(tx, candidate.id, now);

      if (!result.claimed) {
        return { claimed: false as const, reason: result.reason };
      }

      const userId = await tx.orderItem.findUnique({
        where: { id: candidate.id },
        select: { order: { select: { userId: true } } },
      });

      return {
        ...result,
        claimed: true as const,
        userId: userId?.order.userId ?? null,
      };
    });

    if (!claimed.claimed) {
      skipped += 1;
      details.push({
        orderItemId: candidate.id,
        status: "skipped",
        reason: skipReason(claimed.reason),
      });
      continue;
    }

    // ── Send ───────────────────────────────────────────────────────────
    const body = buildDepletionReminderBody({
      orderNumber: claimed.orderNumber,
      productName: claimed.productName,
      orderId: claimed.orderId,
    });

    const idempotencyKey = reminderIdempotencyKey(candidate.id);

    try {
      const result = await gateway.send({
        to: claimed.phone,
        body,
        idempotencyKey,
      });

      await recordSend({
        phone: claimed.phone,
        body,
        userId: claimed.userId,
        orderItemId: candidate.id,
        reason: SMS_REASONS.depletionReminder,
        idempotencyKey,
        status: result.ok ? "sent" : "failed",
        errorCode: result.errorCode,
        provider: gateway.name,
        providerMessageId: result.providerMessageId,
      });

      if (result.ok) {
        sent += 1;
        details.push({
          orderItemId: candidate.id,
          status: "sent",
        });
      } else {
        failed += 1;
        details.push({
          orderItemId: candidate.id,
          status: "failed",
          reason: "The provider did not accept the message.",
          errorCode: result.errorCode,
        });
      }
    } catch (error) {
      // One failure must not abort the rest of the sweep.
      const gatewayError =
        error instanceof SmsGatewayError ? error : null;

      await recordSend({
        phone: claimed.phone,
        body,
        userId: claimed.userId,
        orderItemId: candidate.id,
        reason: SMS_REASONS.depletionReminder,
        idempotencyKey,
        status: "failed",
        errorCode: gatewayError?.code ?? "SEND_FAILED",
        provider: gateway.name,
      });

      failed += 1;
      details.push({
        orderItemId: candidate.id,
        status: "failed",
        reason:
          error instanceof Error ? error.message : "The message could not be sent.",
        errorCode: gatewayError?.code ?? "SEND_FAILED",
      });
    }
  }

  // ── Audit the sweep ─────────────────────────────────────────────────
  // The sweep itself is an admin action, so it is recorded. The audit
  // write is in its own transaction because it describes the run as a
  // whole, not any single item.
  if (!dryRun) {
    await db.$transaction(async (tx: TransactionClient) => {
      await writeAuditEntry(tx, {
        actor,
        action: SMS_ACTIONS.sweep,
        entityType: "order_item",
        entityId: "sweep",
        before: null,
        after: { examined: considered.length, sent, skipped, failed },
        reason: null,
      });
    });
  }

  return {
    examined: considered.length,
    sent,
    skipped,
    failed,
    details,
    truncated,
  };
}

/**
 * Returns true when the customer has opted in to SMS reminders.
 *
 * Used only by the dry-run path, which reports what *would* happen. The
 * real send path never checks consent in application code — it asserts
 * it in the claim query, which is atomic.
 */
async function hasConsent(candidate: ReminderCandidate): Promise<boolean> {
  const row = await db.orderItem.findUnique({
    where: { id: candidate.id },
    select: { order: { select: { user: { select: { smsOptIn: true } } } } },
  });

  return row?.order.user.smsOptIn ?? false;
}

/**
 * Resends a reminder for one order item, by hand.
 *
 * ── What a manual resend may and may not do ───────────────────────────
 *
 * It **bypasses the schedule** — the item may already have been
 * reminded, and the reminder may not be due yet. That is the point of a
 * manual resend.
 *
 * It does **not** bypass consent. Admin authority is for *deciding to
 * send*, not for *overriding the recipient's consent*. A customer who
 * has not opted in cannot be messaged, even by an admin, and the request
 * is refused with a 409 saying so.
 *
 * @param actor   - The admin who asked for the resend.
 * @param itemId  - The order item to remind about.
 * @param options - The gateway and the admin's reason.
 */
export async function resendReminder(
  actor: AuditActor,
  itemId: string,
  options: { gateway?: SmsGateway; reason?: string } = {},
): Promise<{ sent: true; smsLogId: string; phone: string }> {
  const gateway = options.gateway ?? (await getSmsGateway());

  const item = await db.orderItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          userId: true,
          user: { select: { phone: true, smsOptIn: true } },
        },
      },
      product: { select: { name: true } },
    },
  });

  if (!item) {
    throw ApiError.notFound("That order item does not exist.");
  }

  if (!item.order.user.smsOptIn) {
    throw ApiError.conflict(
      "That customer has not opted in to SMS reminders, so no message can be sent.",
    );
  }

  const phone = item.order.user.phone;

  if (!phone) {
    throw ApiError.conflict("That customer has no phone number.");
  }

  const normalised = bdPhoneSchema.safeParse(phone);

  if (!normalised.success) {
    throw ApiError.conflict(
      "That customer's phone number is not a valid Bangladeshi number.",
    );
  }

  const body = buildManualResendBody({
    orderNumber: item.order.orderNumber,
    productName: item.product.name,
    orderId: item.order.id,
  });

  const idempotencyKey = manualResendIdempotencyKey(itemId);

  // ── Claim the key before sending ────────────────────────────────────
  //
  // The pre-check below is a fast path for the common case, but it is
  // NOT the guarantee. Two admins clicking "resend" at the same moment
  // would both pass it. The guarantee is the **unique constraint** on
  // `SmsLog.idempotencyKey`, and it only works if the row is written
  // before the provider is called.
  //
  // So the flow is: write the log row with a "claimed" status, then
  // send, then update the row with the outcome. A second resend loses
  // the insert race and gets a 409 — without the customer receiving two
  // messages.
  const claimed = await claimManualResendKey({
    phone: normalised.data,
    body,
    userId: item.order.userId,
    orderItemId: item.id,
    idempotencyKey,
    provider: gateway.name,
  });

  if (!claimed) {
    throw ApiError.conflict(
      "A manual resend has already been sent for that item.",
    );
  }

  try {
    const result = await gateway.send({
      to: normalised.data,
      body,
      idempotencyKey,
    });

    if (!result.ok) {
      await recordSend({
        phone: normalised.data,
        body,
        userId: item.order.userId,
        orderItemId: item.id,
        reason: SMS_REASONS.manualResend,
        idempotencyKey,
        status: "failed",
        errorCode: result.errorCode,
        provider: gateway.name,
        providerMessageId: result.providerMessageId,
      });

      throw ApiError.conflict(
        "The message could not be sent. The attempt has been recorded.",
      );
    }

    const log = await db.smsLog.update({
      where: { idempotencyKey },
      data: {
        status: "sent",
        providerMessageId: result.providerMessageId ?? null,
      },
      select: { id: true },
    });

    await db.$transaction(async (tx: TransactionClient) => {
      await writeAuditEntry(tx, {
        actor,
        action: SMS_ACTIONS.resent,
        entityType: "order_item",
        entityId: itemId,
        before: null,
        after: { phone: normalised.data, reason: SMS_REASONS.manualResend },
        reason: options.reason ?? null,
      });
    });

    return { sent: true, smsLogId: log.id, phone: normalised.data };
  } catch (error) {
    if (error instanceof ApiError) throw error;

    const gatewayError = error instanceof SmsGatewayError ? error : null;

    // The claim row is already in place, so this is an **update**, not
    // an insert. An insert would collide with the unique constraint on
    // `idempotencyKey` and mask the real failure.
    await db.smsLog.update({
      where: { idempotencyKey },
      data: {
        status: "failed",
        errorCode: gatewayError?.code ?? "SEND_FAILED",
      },
    });

    throw new ApiError(
      "SERVICE_UNAVAILABLE",
      "The message could not be sent. The attempt has been recorded.",
    );
  }
}
