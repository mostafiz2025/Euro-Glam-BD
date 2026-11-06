"use client";

import {
  CheckIcon,
  CreditCardIcon,
  WalletIcon,
} from "@/components/ui/icons";
import type { PaymentMethodInput } from "@/lib/validation/commerce";

/**
 * The payment method selector.
 *
 * ── The rule that governs this component ─────────────────────────────────
 *
 * **It selects a method. It collects nothing.**
 *
 * The checkout page holds **only** the payment choice. No card fields,
 * no wallet radio buttons, no transfer reference. Whatever the customer
 * will be asked for is asked for somewhere else.
 *
 * ── Why this is now two options and not four ───────────────────────────────
 *
 * The shop used to offer four cards — Cash on Delivery, bKash, Nagad
 * and Card. That was a **local-transfer** design: the shop itself
 * received the money, so it had to know which operator sent it, and
 * the operator therefore had to be chosen before the order existed.
 *
 * The shop now settles online payments through **SSLCOMMERZ**, and that
 * changes the shape of the decision. SSLCOMMERZ's own hosted page
 * presents bKash, Nagad, Visa and Mastercard together and tells the
 * customer which ones their card or wallet can use. So the customer is
 * no longer choosing an operator — they are choosing **how they want to
 * pay**:
 *
 *   • **Cash on Delivery** — pay the courier at the door.
 *   • **Online Payment (SSLCommerz)** — pay now by card, bKash or
 *     Nagad on the gateway's own secure page.
 *
 * That is the shape every large marketplace uses, and it is the shape
 * the customer expects: one clear decision, then the gateway's own page
 * handles the detail.
 *
 * **Why the order row still records `CARD`.**
 *
 * The `PaymentMethod` enum is `COD | BKASH | NAGAD | CARD`, and it is
 * the reconciliation record — DECISIONS.md #147 requires the operator
 * to survive into the order row. But with a hosted gateway, the
 * operator is chosen **by the customer on the gateway's page**, not by
 * this form. The order is created *before* the gateway session opens
 * (the order must exist for the callback to find it), so at creation
 * time the operator is genuinely unknown.
 *
 * So this option records `CARD`, which is the enum's generic
 * "settled through the online gateway" value, and the gateway's own
 * callback records what actually happened — the gateway's `card_type`
 * names the rail it used, and it is written onto the order by
 * `handleSslCommerzSuccess` as `BKASH`, `NAGAD`, or left as `CARD` for
 * a real card. The gateway's `bank_tran_id` is stored as the
 * reconciliation reference. The order row therefore still ends up
 * carrying the real rail, and it still ends up carrying a reference the
 * shop can reconcile against.
 *
 * The order page reads that row, so a customer who paid with bKash sees
 * "Paid by bKash" — not "Card Payment". The badge is right because the
 * gateway said so, not because the checkout guessed.
 *
 * `BKASH` and `NAGAD` remain in the enum and remain **reachable**: an
 * order recorded with one of them is settled by the local transfer
 * window, and the order page's "Pay now" button opens it. The enum
 * values are not deleted — only this form stops offering them as a
 * first-class choice.
 *
 * ── The rules that shape it ───────────────────────────────────────────────
 *
 * **1. The radio group is the source of truth, not a set of buttons.**
 *
 * Native `<input type="radio">` elements are used, inside a
 * `<fieldset>` with a `<legend>`. That is not nostalgia — it is the
 * only way to get the behaviour that matters:
 *
 *   • **Arrow keys move between options.** A group of `<button>`s does
 *     not do this; a radio group does, for free, because the browser
 *     implements it.
 *   • **A screen reader announces the group and the position.** "Cash on
 *     Delivery, radio button, 1 of 2" is what a customer using a
 *     screen reader needs to know. Buttons announce as buttons.
 *   • **The selected state is real.** `checked` is the browser's own
 *     notion of it, so it survives a form reset, is announced, and
 *     participates in the form's own semantics.
 *
 * The radio is visually replaced with a styled ring, but it is never
 * removed from the accessibility tree — `appearance-none` plus a
 * `peer` sibling, with the radio kept focusable and labelled.
 *
 * **2. The two options are radio inputs, not a decorative strip.**
 *
 * The obvious way to build this is a `<div>` of buttons that changes
 * some state — which is exactly the "set of buttons" rule 1 warns
 * against, and it would regress the accessibility this component was
 * deliberately built with. So each card is a `<label>` wrapping a real
 * radio, and the cards are styled as the reference's selection cards.
 * The visual layer and the semantic layer are the same thing.
 *
 * **3. The method is the customer's choice, and it is sent with the
 * order.**
 *
 * The chosen method travels in the request body, and the server stores
 * it on the order. That happens at placement — the method is fixed
 * before the gateway session opens, and the server reads it from the
 * order row rather than from the gateway request.
 *
 * **4. The page is a flat list of cards, with no inline payment fields.**
 *
 * There is no wallet radio group, no card input and no TrxID field
 * anywhere in this component. The page carries the **choice**; the
 * gateway page carries the **details**.
 */

/**
 * The icon each card draws.
 *
 * A key rather than a component, so the table below stays plain data
 * and this module stays the only place that resolves a method to a
 * glyph.
 */
export type PaymentOptionIcon = "wallet" | "gateway";

/**
 * The payment methods, in the order they are offered.
 *
 * **One table, one row per method.** There is no second, parallel table
 * and no nested sub-choice: each card in the grid *is* a method, and
 * the method it carries is the method the order is recorded with.
 *
 * COD is first because it is the platform's default (DECISIONS.md #4)
 * and the method most of the shop's customers use.
 *
 * The online option records `CARD`, because the operator is chosen by
 * the customer on SSLCOMMERZ's own page — see the module docblock for
 * the full argument, and for why that does not lose the operator from
 * the order row.
 */
export const PAYMENT_OPTIONS: ReadonlyArray<{
  readonly value: PaymentMethodInput;
  readonly label: string;
  readonly description: string;
  readonly icon: PaymentOptionIcon;
  /** The sub-label shown on the card, e.g. the rails it bundles. */
  readonly detail: string;
}> = [
  {
    value: "COD",
    label: "Cash on Delivery",
    description: "Pay the courier in cash when your parcel arrives.",
    detail: "Pay at your door",
    icon: "wallet",
  },
  {
    value: "CARD",
    label: "Online Payment",
    description: "Pay securely by card, bKash or Nagad.",
    detail: "SSLCommerz · bKash · Nagad · Cards",
    icon: "gateway",
  },
];

/**
 * What happens after "Place order", for each method.
 *
 * **One sentence, per method.** The customer is about to be handed over
 * to the gateway, so saying it here means the handover is never a
 * surprise.
 *
 * The wording is deliberately **explanatory rather than instructional**:
 * it says where the next step happens, not what to type. The card
 * details themselves are collected on the gateway's own page, next to
 * the amount, and this sentence points at that.
 */
const PAYMENT_NEXT_STEP: Record<string, string> = {
  COD: "The courier collects the order total in cash when your parcel arrives. Nothing is charged now.",
  CARD:
    "After you place the order, we will open our secure SSLCommerz payment page, where you can pay by card, bKash or Nagad.",
};

/**
 * The props for the selector.
 */
export type PaymentMethodSelectorProps = {
  /** The currently selected method. */
  readonly value: PaymentMethodInput;
  /** Called when the customer picks a different method. */
  readonly onChange: (value: PaymentMethodInput) => void;
};

/**
 * The icon for an option.
 *
 * Resolved from the `icon` key on the option, so the table above stays
 * plain data and this component stays the only place that knows which
 * glyph belongs to which method.
 */
function OptionIcon({
  icon,
  className,
}: {
  readonly icon: PaymentOptionIcon;
  readonly className?: string;
}) {
  if (icon === "wallet") {
    return <WalletIcon width={20} height={20} className={className} />;
  }

  return <CreditCardIcon width={20} height={20} className={className} />;
}

/**
 * The payment method selector.
 */
export function PaymentMethodSelector({
  value,
  onChange,
}: PaymentMethodSelectorProps) {
  return (
    <fieldset className="mt-4">
      <legend className="sr-only">Payment method</legend>

      {/*
        The cards.

        Each card is a `<label>` wrapping a real radio input. The radio
        is `sr-only` and `peer`, and the visible card is the styled
        sibling — so the card is drawn by CSS from the radio's real
        `checked` state, and the radio keeps its focus, its name and
        its position in the group's announcement.

        Two cards in a single column on the narrowest screens and two
        columns from `sm`. A single row where there is room, so the
        customer sees both options at once and the choice reads as one
        decision rather than a decision plus a follow-up.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        {PAYMENT_OPTIONS.map((option) => {
          const isSelected = value === option.value;
          const inputId = `payment-option-${option.value}`;

          return (
            <label
              key={option.value}
              htmlFor={inputId}
              className={[
                "flex cursor-pointer flex-col gap-3 rounded-2xl border p-4",
                "transition-all duration-200 ease-[var(--ease-out-soft)]",
                "focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2",
                isSelected
                  ? "border-brand-400 bg-brand-50 ring-1 ring-brand-300"
                  : "border-border bg-surface hover:border-brand-200 hover:bg-brand-50/40",
              ].join(" ")}
            >
              <input
                id={inputId}
                type="radio"
                name="paymentMethod"
                value={option.value}
                checked={isSelected}
                onChange={() => onChange(option.value)}
                className="peer sr-only"
              />

              <span className="flex items-start justify-between gap-2">
                <span
                  aria-hidden="true"
                  className={[
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                    "transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500",
                    isSelected
                      ? "bg-brand-600 text-white"
                      : "bg-surface-muted text-foreground-muted",
                  ].join(" ")}
                >
                  <OptionIcon icon={option.icon} />
                </span>

                {/*
                  The selection ring.

                  Drawn from the radio's `checked` state by the
                  `peer` sibling, so it is the browser's own notion of
                  selection rather than a second piece of state.
                */}
                <span
                  aria-hidden="true"
                  className={[
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                    "transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2",
                    isSelected
                      ? "border-brand-600 bg-brand-600 text-white"
                      : "border-neutral-300 bg-surface",
                  ].join(" ")}
                >
                  {isSelected ? <CheckIcon width={12} height={12} /> : null}
                </span>
              </span>

              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">
                  {option.label}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-foreground-muted">
                  {option.description}
                </span>

                {/*
                  The detail line.

                  The rails the option bundles, named up front. This is
                  what replaces the old inline wallet buttons: the
                  customer is told that bKash, Nagad and cards are all
                  available **without** being asked to pick one here.
                */}
                <span className="mt-2 block text-[11px] font-medium text-foreground-muted">
                  {option.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {/*
        What happens next.

        One sentence, and it changes with the method — because the
        customer is about to be handed over to a very different place.

        It is here, on the checkout page, rather than only on the
        gateway's own page, so the customer is not surprised by a
        redirect they were not expecting.
      */}
      <p className="mt-4 rounded-xl bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-foreground-muted">
        {PAYMENT_NEXT_STEP[value] ??
          "Choose a payment method to continue."}
      </p>
    </fieldset>
  );
}
