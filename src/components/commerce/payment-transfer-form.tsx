"use client";

import { useState } from "react";

import { senderNumberSchema, transactionIdSchema } from "@/lib/validation/commerce";

/**
 * The transfer details form.
 *
 * ── What this component is ────────────────────────────────────────────────
 *
 * The two fields a mobile-banking payment needs: the number the transfer
 * was sent **from**, and the **TrxID** from the customer's confirmation
 * screen.
 *
 * They are collected in the **gateway window**, next to the amount, because
 * that is where the customer is actually looking at the amount they are
 * about to send — which is the moment they have the confirmation screen in
 * their hand.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The two fields are a pair.**
 *
 * A transfer reference with a sender number but no TrxID cannot be
 * reconciled against a merchant statement, and neither can a TrxID with no
 * sender number. So the two are validated together: half a transfer is not
 * a transfer, and the form says so rather than letting the customer
 * discover it at settlement.
 *
 * **2. The validation is the server's rule, reused.**
 *
 * `senderNumberSchema` and `transactionIdSchema` are imported from
 * `src/lib/validation/commerce.ts` — the **same** schemas the settle
 * endpoint validates against. A second implementation of "what is a valid
 * TrxID" would be a second thing to keep in step with the first, and the
 * two would drift: a TrxID this form accepted and the server refused, or
 * worse, the reverse.
 *
 * The schemas are Zod, so importing them pulls Zod into the client bundle
 * for this component. That is the price of having one definition of the
 * rule, and it is worth paying: the alternative is two definitions, and
 * one of them is wrong.
 *
 * **3. The number is normalised to the local form.**
 *
 * `senderNumberSchema` transforms `+8801712345678`, `8801712345678`,
 * `01712345678` and `1712345678` into `01712345678` — the format the
 * operators themselves display on their statements. The value that leaves
 * this form is therefore already the value the shop will search for when
 * it reconciles the transfer against a merchant statement.
 *
 * **4. Nothing here is stored beyond the modal.**
 *
 * The two values are state in the modal and are sent with the settle
 * request. They are **not** persisted anywhere else, and the order row
 * that receives them is written by the server as it marks the order
 * `PAID`.
 */

/**
 * The transfer details, as the customer typed them.
 */
export type TransferDetails = {
  /** The mobile number the transfer was sent from. */
  readonly senderNumber: string;
  /** The TrxID from the confirmation screen. */
  readonly transactionId: string;
};

/**
 * An empty set of transfer details.
 */
export const EMPTY_TRANSFER_DETAILS: TransferDetails = {
  senderNumber: "",
  transactionId: "",
};

/**
 * The props for the form.
 */
export type PaymentTransferFormProps = {
  /** The current transfer details. */
  readonly value: TransferDetails;
  /** Called when any of the details change. */
  readonly onChange: (value: TransferDetails) => void;
  /**
   * The validation errors, keyed by field name.
   *
   * Owned by the parent, because the parent is what decides whether the
   * payment may be sent — and a mobile-banking payment cannot settle
   * without a transfer reference.
   */
  readonly errors?: Partial<Record<keyof TransferDetails, string>>;
  /** Whether the customer has attempted to pay. */
  readonly submitted?: boolean;
  /**
   * The wallet's name, shown in the labels and the reassurance.
   *
   * "bKash" and "Nagad" are not interchangeable in a sentence about a
   * transfer — the customer is quoting a TrxID from one specific
   * operator's confirmation screen.
   */
  readonly operatorName: string;
};

/**
 * The transfer details form.
 */
export function PaymentTransferForm({
  value,
  onChange,
  errors = {},
  submitted = false,
  operatorName,
}: PaymentTransferFormProps) {
  /**
   * The fields the customer has left at least once.
   *
   * This is what makes the validation "on blur" rather than "on every
   * keystroke": a field is only judged once the customer has finished
   * with it. Before that it is silent.
   */
  const [touched, setTouched] = useState<
    Partial<Record<keyof TransferDetails, boolean>>
  >({});

  /**
   * The error for a field, if it should be shown.
   *
   * An error is shown when the customer has **submitted** (so every
   * problem surfaces at once) or when the customer has **left** the
   * field (so they learn about it at the moment they could fix it).
   */
  function errorFor(field: keyof TransferDetails): string | undefined {
    if (submitted) return errors[field];
    if (!touched[field]) return undefined;
    return errors[field];
  }

  function markTouched(field: keyof TransferDetails): void {
    setTouched((current) =>
      current[field] ? current : { ...current, [field]: true },
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <p className="text-sm font-semibold text-foreground">
        Enter your transfer details
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-foreground-muted">
        Send the exact total to our {operatorName} merchant number, then
        enter the number you sent it from and the TrxID from your
        confirmation screen.
      </p>

      <div className="mt-4 space-y-4">
        {/* ── The sender number ────────────────────────────────────── */}
        <div>
          <label
            htmlFor="transferSenderNumber"
            className="block text-xs font-semibold text-foreground-muted"
          >
            Sender&apos;s mobile number
          </label>

          <input
            id="transferSenderNumber"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={value.senderNumber}
            onChange={(event) =>
              onChange({ ...value, senderNumber: event.target.value })
            }
            onBlur={() => markTouched("senderNumber")}
            placeholder="01712345678"
            aria-invalid={errorFor("senderNumber") ? true : undefined}
            aria-describedby={
              errorFor("senderNumber")
                ? "transferSenderNumber-error"
                : "transferSenderNumber-hint"
            }
            className={[
              "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
              "transition-colors placeholder:text-foreground-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              errorFor("senderNumber")
                ? "border-red-300 focus-visible:ring-red-400"
                : "border-border focus-visible:border-brand-400",
            ].join(" ")}
          />

          {errorFor("senderNumber") ? (
            <p
              id="transferSenderNumber-error"
              role="alert"
              className="mt-1.5 text-xs text-red-600"
            >
              {errorFor("senderNumber")}
            </p>
          ) : (
            <p
              id="transferSenderNumber-hint"
              className="mt-1.5 text-[11px] text-foreground-muted"
            >
              The number you sent the payment from.
            </p>
          )}
        </div>

        {/* ── The TrxID ────────────────────────────────────────────── */}
        <div>
          <label
            htmlFor="transferTransactionId"
            className="block text-xs font-semibold text-foreground-muted"
          >
            Transaction ID (TrxID)
          </label>

          <input
            id="transferTransactionId"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={value.transactionId}
            onChange={(event) =>
              onChange({ ...value, transactionId: event.target.value })
            }
            onBlur={() => markTouched("transactionId")}
            placeholder="e.g. 8H3K2M9Q"
            aria-invalid={errorFor("transactionId") ? true : undefined}
            aria-describedby={
              errorFor("transactionId")
                ? "transferTransactionId-error"
                : "transferTransactionId-hint"
            }
            className={[
              "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
              "transition-colors placeholder:text-foreground-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              errorFor("transactionId")
                ? "border-red-300 focus-visible:ring-red-400"
                : "border-border focus-visible:border-brand-400",
            ].join(" ")}
          />

          {errorFor("transactionId") ? (
            <p
              id="transferTransactionId-error"
              role="alert"
              className="mt-1.5 text-xs text-red-600"
            >
              {errorFor("transactionId")}
            </p>
          ) : (
            <p
              id="transferTransactionId-hint"
              className="mt-1.5 text-[11px] text-foreground-muted"
            >
              From your {operatorName} confirmation screen.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Validates the transfer details and returns the errors.
 *
 * ── Why this lives outside the component ─────────────────────────────────
 *
 * The **parent** needs the answer, not the panel: the PAY button is
 * disabled while the transfer details are incomplete, because a
 * mobile-banking payment cannot settle without them.
 *
 * The rules are the **server's** rules, reused. `senderNumberSchema` and
 * `transactionIdSchema` are the same schemas the settle endpoint
 * validates against, so the browser and the server cannot disagree about
 * what a valid TrxID is.
 *
 * The two fields are validated **as a pair**: half a transfer is not a
 * transfer, so a body with one and not the other is refused — by the
 * browser and by the server alike.
 *
 * @param details - The transfer details as typed.
 */
export function validateTransferDetails(
  details: TransferDetails,
): Partial<Record<keyof TransferDetails, string>> {
  const errors: Partial<Record<keyof TransferDetails, string>> = {};

  const sender = senderNumberSchema.safeParse(details.senderNumber);
  const transaction = transactionIdSchema.safeParse(details.transactionId);

  const senderFilled = details.senderNumber.trim() !== "";
  const transactionFilled = details.transactionId.trim() !== "";

  if (!senderFilled) {
    errors.senderNumber = "Enter the mobile number you sent the payment from.";
  } else if (!sender.success) {
    errors.senderNumber =
      sender.error.issues[0]?.message ??
      "Enter the sender's mobile number (e.g. 01712345678).";
  }

  if (!transactionFilled) {
    errors.transactionId =
      "Enter the transaction ID (TrxID) from your confirmation screen.";
  } else if (!transaction.success) {
    errors.transactionId =
      transaction.error.issues[0]?.message ??
      "That transaction ID is not valid.";
  }

  return errors;
}

/**
 * Whether the transfer details are complete and well-formed.
 */
export function isTransferDetailsValid(details: TransferDetails): boolean {
  return Object.keys(validateTransferDetails(details)).length === 0;
}

/**
 * Normalises the transfer details into the form the settle endpoint
 * expects.
 *
 * The schemas transform the values — the sender number into the local
 * `01XXXXXXXXX` form, the TrxID into upper case — so the value sent here
 * is the value the shop will search for when it reconciles the transfer
 * against a merchant statement.
 *
 * `+8801712345678` and `01712345678` are the same transfer, and the
 * shop's reconciliation query has to find it under the form the operator
 * printed. Normalising in the browser means the server stores the same
 * string the statement carries, so the two match.
 */
export function normaliseTransferDetails(
  details: TransferDetails,
): { paymentSenderNumber: string; paymentTransactionId: string } {
  const sender = senderNumberSchema.parse(details.senderNumber);
  const transaction = transactionIdSchema.parse(details.transactionId);

  return {
    paymentSenderNumber: sender,
    paymentTransactionId: transaction,
  };
}
