"use client";

import { useState } from "react";

import {
  cardBrandLabel,
  detectCardBrand,
  formatCardNumber,
  formatCvc,
  formatExpiry,
  isValidCardHolder,
  isValidCardNumber,
  isValidCvc,
  isValidExpiry,
  type CardBrand,
} from "@/lib/format/card";

/**
 * The card details form.
 *
 * ── The rule that governs this component ─────────────────────────────────
 *
 * **Nothing typed here leaves the browser.**
 *
 * This panel lives in the **gateway window** — the customer types their
 * card there, next to the amount, in the same place a real gateway
 * would ask for it. The card number, the expiry, the CVC and the holder
 * name are collected, shown back to the customer, and validated — and
 * then **discarded**. They are not given a `name` attribute, so they are
 * not part of any form's `FormData`; they are not part of the request
 * body; and the server **refuses** them if they ever arrive (see
 * `checkoutSchema`'s `superRefine` and `gatewaySettleSchema`'s
 * `.strict()`).
 *
 * Three independent guards, because "the card details are never sent"
 * is a security property, and a property that depends on one careful
 * line of code is a property that one future edit can remove:
 *
 *   1. **State-only.** The values live in React state and never get a
 *      `name`, so a `FormData` sweep cannot pick them up.
 *   2. **An explicit allow-list.** The request body is assembled from a
 *      fixed set of keys, and these are not among them.
 *   3. **A server-side refusal.** `checkoutSchema` rejects the four
 *      keys outright, and `gatewaySettleSchema` is `.strict()`, so a
 *      leak becomes a loud `400` rather than a silent strip.
 *
 * A shop that stores a card number is a shop that has breached PCI DSS.
 * This shop stores the payment *method* and the gateway's own reference,
 * and nothing else.
 *
 * ── When the validation runs ──────────────────────────────────────────────
 *
 * **On blur and on submit — never on every keystroke.**
 *
 * A field that shouts "invalid" while the customer is still typing the
 * third digit of a sixteen-digit number is worse than no validation at
 * all: it is wrong most of the time, and it trains the customer to
 * ignore the field. So a field is silent until the customer leaves it or
 * tries to submit, and then it says exactly what is wrong.
 *
 * The one exception is the **brand chip**, which updates as the customer
 * types. That is not validation — it is feedback about what has been
 * recognised so far, and it is genuinely useful while typing.
 */

/**
 * The card details, as the customer typed them.
 *
 * A plain object of strings. It is never serialised into the request.
 */
export type CardDetails = {
  readonly cardNumber: string;
  readonly cardExpiry: string;
  readonly cardCvc: string;
  readonly cardHolderName: string;
};

/**
 * An empty set of card details.
 */
export const EMPTY_CARD_DETAILS: CardDetails = {
  cardNumber: "",
  cardExpiry: "",
  cardCvc: "",
  cardHolderName: "",
};

/**
 * The field names, so the form and the errors agree on them.
 */
export type CardFieldName = keyof CardDetails;

/**
 * The props for the card form.
 */
export type CardDetailsFormProps = {
  /** The current card details. */
  readonly value: CardDetails;
  /** Called when any of the details change. */
  readonly onChange: (value: CardDetails) => void;
  /**
   * The validation errors, keyed by field name.
   *
   * Owned by the parent, because the parent is what decides whether the
   * order may be placed — and a card payment cannot proceed with a
   * malformed card number.
   */
  readonly errors?: Partial<Record<CardFieldName, string>>;
  /** Whether the customer has attempted to submit. */
  readonly submitted?: boolean;
};

/**
 * The card details form.
 */
export function CardDetailsForm({
  value,
  onChange,
  errors = {},
  submitted = false,
}: CardDetailsFormProps) {
  /**
   * The fields the customer has left at least once.
   *
   * This is what makes the validation "on blur" rather than "on every
   * keystroke": a field is only judged once the customer has finished
   * with it. Before that it is silent.
   */
  const [touched, setTouched] = useState<Partial<Record<CardFieldName, boolean>>>(
    {},
  );

  /**
   * The brand the card number looks like.
   *
   * Recomputed from the number on every render, because it is derived
   * state — it is *about* the number, not a separate thing the customer
   * sets. It never becomes stale.
   */
  const brand: CardBrand = detectCardBrand(value.cardNumber);

  /**
   * Whether the customer has typed enough digits for the brand to be
   * worth announcing.
   *
   * A brand chip that appears on the first keystroke would flash
   * "unknown" at the customer and then correct itself, which reads as a
   * glitch. It appears once the prefix is actually recognisable.
   */
  const showBrand = brand !== "unknown";

  /**
   * The label for the security code.
   *
   * American Express calls it the **CID**; every other network calls it
   * the **CVC**. It is a small detail, but it is the detail a customer
   * with an Amex card looks for — and if the label says "CVC" they will
   * look on the back of the card, where Amex does not print it.
   */
  const cvcLabel = brand === "amex" ? "CID" : "CVC";

  /**
   * The error for a field, if it should be shown.
   *
   * An error is shown when the customer has **submitted** (so every
   * problem surfaces at once) or when the customer has **left** the
   * field (so they learn about it at the moment they could fix it).
   */
  function errorFor(field: CardFieldName): string | undefined {
    if (submitted) return errors[field];
    if (!touched[field]) return undefined;
    return errors[field];
  }

  function markTouched(field: CardFieldName): void {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5">
      {/*
        The heading and the honest note.

        The panel says plainly that the card details are not stored. The
        honest thing about a simulation is to say it where the customer
        will actually read it — and the customer reads it right here,
        because this is where they type the card.
      */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Card details</p>
          <p className="mt-1 text-[11px] leading-relaxed text-foreground-muted">
            Your card is checked in the browser. The details are never sent
            to or stored by this shop.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {/* ── The card number ───────────────────────────────────────── */}
        <div>
          <label
            htmlFor="cardNumber"
            className="block text-xs font-semibold text-foreground-muted"
          >
            Card number
          </label>

          <div className="relative mt-1.5">
            <input
              id="cardNumber"
              type="text"
              inputMode="numeric"
              autoComplete="cc-number"
              value={value.cardNumber}
              onChange={(event) =>
                onChange({
                  ...value,
                  cardNumber: formatCardNumber(event.target.value),
                })
              }
              onBlur={() => markTouched("cardNumber")}
              placeholder="4242 4242 4242 4242"
              aria-invalid={errorFor("cardNumber") ? true : undefined}
              aria-describedby={
                errorFor("cardNumber") ? "cardNumber-error" : "cardNumber-hint"
              }
              className={[
                "h-12 w-full rounded-xl border bg-surface px-3.5 pr-24 text-sm tracking-[0.06em] text-foreground",
                "transition-colors placeholder:tracking-normal placeholder:text-foreground-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                errorFor("cardNumber")
                  ? "border-red-300 focus-visible:ring-red-400"
                  : "border-border focus-visible:border-brand-400",
              ].join(" ")}
            />

            {/*
              The brand chip.

              It is `aria-hidden` — the brand is announced through the
              field's description instead, so a screen reader reads
              "Card number, Visa" once rather than twice. The chip is
              decoration on top of an already-described field.
            */}
            {showBrand ? (
              <span
                aria-hidden="true"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-border bg-surface-muted px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-foreground-muted"
              >
                {cardBrandLabel(brand)}
              </span>
            ) : null}
          </div>

          {errorFor("cardNumber") ? (
            <p id="cardNumber-error" role="alert" className="mt-1.5 text-xs text-red-600">
              {errorFor("cardNumber")}
            </p>
          ) : (
            <p id="cardNumber-hint" className="mt-1.5 text-[11px] text-foreground-muted">
              {showBrand
                ? `${cardBrandLabel(brand)} detected.`
                : "We accept Visa, Mastercard, American Express and Discover."}
            </p>
          )}
        </div>

        {/* ── The expiry and the CVC ────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="cardExpiry"
              className="block text-xs font-semibold text-foreground-muted"
            >
              Expiry date
            </label>

            <input
              id="cardExpiry"
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp"
              value={value.cardExpiry}
              onChange={(event) =>
                onChange({
                  ...value,
                  cardExpiry: formatExpiry(event.target.value),
                })
              }
              onBlur={() => markTouched("cardExpiry")}
              placeholder="MM/YY"
              aria-invalid={errorFor("cardExpiry") ? true : undefined}
              aria-describedby={errorFor("cardExpiry") ? "cardExpiry-error" : undefined}
              className={[
                "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
                "transition-colors placeholder:text-foreground-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                errorFor("cardExpiry")
                  ? "border-red-300 focus-visible:ring-red-400"
                  : "border-border focus-visible:border-brand-400",
              ].join(" ")}
            />

            {errorFor("cardExpiry") ? (
              <p id="cardExpiry-error" role="alert" className="mt-1.5 text-xs text-red-600">
                {errorFor("cardExpiry")}
              </p>
            ) : null}
          </div>

          <div>
            <label
              htmlFor="cardCvc"
              className="block text-xs font-semibold text-foreground-muted"
            >
              {cvcLabel}
            </label>

            <input
              id="cardCvc"
              type="text"
              inputMode="numeric"
              autoComplete="cc-csc"
              value={value.cardCvc}
              onChange={(event) =>
                onChange({
                  ...value,
                  cardCvc: formatCvc(event.target.value),
                })
              }
              onBlur={() => markTouched("cardCvc")}
              placeholder={brand === "amex" ? "1234" : "123"}
              maxLength={4}
              aria-invalid={errorFor("cardCvc") ? true : undefined}
              aria-describedby={
                errorFor("cardCvc") ? "cardCvc-error" : "cardCvc-hint"
              }
              className={[
                "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
                "transition-colors placeholder:text-foreground-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                errorFor("cardCvc")
                  ? "border-red-300 focus-visible:ring-red-400"
                  : "border-border focus-visible:border-brand-400",
              ].join(" ")}
            />

            {errorFor("cardCvc") ? (
              <p id="cardCvc-error" role="alert" className="mt-1.5 text-xs text-red-600">
                {errorFor("cardCvc")}
              </p>
            ) : (
              <p id="cardCvc-hint" className="mt-1.5 text-[11px] text-foreground-muted">
                {brand === "amex"
                  ? "The 4-digit code on the front of your card."
                  : "The 3-digit code on the back of your card."}
              </p>
            )}
          </div>
        </div>

        {/* ── The holder name ───────────────────────────────────────── */}
        <div>
          <label
            htmlFor="cardHolderName"
            className="block text-xs font-semibold text-foreground-muted"
          >
            Card holder name
          </label>

          <input
            id="cardHolderName"
            type="text"
            autoComplete="cc-name"
            value={value.cardHolderName}
            onChange={(event) =>
              onChange({
                ...value,
                cardHolderName: event.target.value,
              })
            }
            onBlur={() => markTouched("cardHolderName")}
            placeholder="Ayesha Rahman"
            aria-invalid={errorFor("cardHolderName") ? true : undefined}
            aria-describedby={
              errorFor("cardHolderName") ? "cardHolderName-error" : undefined
            }
            className={[
              "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
              "transition-colors placeholder:text-foreground-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              errorFor("cardHolderName")
                ? "border-red-300 focus-visible:ring-red-400"
                : "border-border focus-visible:border-brand-400",
            ].join(" ")}
          />

          {errorFor("cardHolderName") ? (
            <p
              id="cardHolderName-error"
              role="alert"
              className="mt-1.5 text-xs text-red-600"
            >
              {errorFor("cardHolderName")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Validates the card details and returns the errors.
 *
 * ── Why this lives outside the component ─────────────────────────────────
 *
 * The **parent** needs the answer, not the panel: the submit button is
 * disabled while the card form is invalid, and the submit handler
 * refuses to place an order with a malformed card number. So the
 * validation is a plain function over the details, and the panel is one
 * caller of it.
 *
 * It lives here rather than in `src/lib/validation/` because it is
 * **presentation-adjacent** — it is the browser's opinion on whether the
 * card the customer typed looks like a card. It is not a rule about
 * what may reach the server, and it never authorises a payment. The
 * gateway is a server-side sandbox and the real authorisation is the
 * gateway's.
 *
 * @param details - The card details as typed.
 * @param now - The current date, injectable so the rule can be tested
 *        without depending on the day the suite runs.
 */
export function validateCardDetails(
  details: CardDetails,
  now: Date = new Date(),
): Partial<Record<CardFieldName, string>> {
  const errors: Partial<Record<CardFieldName, string>> = {};

  if (details.cardNumber.trim() === "") {
    errors.cardNumber = "Enter your card number.";
  } else if (!isValidCardNumber(details.cardNumber)) {
    errors.cardNumber = "That card number is not valid. Please check it.";
  }

  if (details.cardExpiry.trim() === "") {
    errors.cardExpiry = "Enter the expiry date.";
  } else if (!isValidExpiry(details.cardExpiry, now)) {
    errors.cardExpiry = "That expiry date is not valid. Use MM/YY.";
  }

  const brand = detectCardBrand(details.cardNumber);

  if (details.cardCvc.trim() === "") {
    errors.cardCvc = "Enter the security code.";
  } else if (!isValidCvc(details.cardCvc, brand)) {
    errors.cardCvc =
      brand === "amex"
        ? "An American Express CID is 4 digits."
        : "The security code is 3 digits.";
  }

  if (details.cardHolderName.trim() === "") {
    errors.cardHolderName = "Enter the name on the card.";
  } else if (!isValidCardHolder(details.cardHolderName)) {
    errors.cardHolderName = "Enter the name exactly as it appears on the card.";
  }

  return errors;
}

/**
 * Whether the card details are complete and well-formed.
 */
export function isCardDetailsValid(
  details: CardDetails,
  now: Date = new Date(),
): boolean {
  return Object.keys(validateCardDetails(details, now)).length === 0;
}
