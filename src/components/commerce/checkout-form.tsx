"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { CouponBox } from "@/components/commerce/coupon-box";
import { PaymentMethodSelector } from "@/components/commerce/payment-method-selector";
import { Button } from "@/components/ui/button";
import type { CartView } from "@/lib/cart/service";
import { formatPaisa } from "@/lib/format/money";
import type { PublicCoupon } from "@/lib/format/types";
import {
  orderConfirmationPath,
  type CheckoutOrderResponse,
} from "@/lib/orders/redirect";
import type { GatewaySessionPayload } from "@/lib/payments/session";
import type { PaymentMethodInput } from "@/lib/validation/commerce";

/**
 * The checkout form.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The client sends no prices.**
 *
 * The body carries the address and the payment method. It does not
 * carry a total, a subtotal, a delivery charge or a product list —
 * the server reads all of that from the cart and the catalogue, and
 * computes what it costs. A checkout that trusted a client-supplied
 * price would trust a number the customer can edit.
 *
 * **2. A blocking conflict must be acknowledged.**
 *
 * The checkout service refuses a `BLOCK` conflict with a 409 unless
 * the customer confirms. The 409 carries the conflict, so this form
 * shows the reason and a checkbox that says, in plain words, what the
 * customer is agreeing to. The customer is told and decides — the
 * system does not silently drop a product.
 *
 * **3. The delivery charge is the server's number.**
 *
 * It is not computed here, and it is not guessed. The summary shows
 * the subtotal — which the server sent — and says the delivery is
 * confirmed at order placement. A client-side delivery calculation
 * would be a second implementation of a pricing rule, and the two
 * would drift.
 *
 * **4. The payment method is the customer's choice, and it is sent
 * with the order.**
 *
 * **Two** methods are offered: Cash on Delivery, and Online Payment
 * (SSLCommerz) — a single option that bundles bKash, Nagad and the
 * card networks.
 *
 * The reason for two, rather than the four the shop used to offer, is
 * the gateway. SSLCOMMERZ's own hosted page presents bKash, Nagad,
 * Visa and Mastercard together and tells the customer which ones they
 * can use. So the customer is not choosing an *operator*; they are
 * choosing *how they want to pay*. That is the shape every large
 * marketplace uses, and it is what a customer expects.
 *
 * The chosen method travels in the request body, and the server stores
 * it on the order. The online option records `CARD`, because the
 * operator is chosen by the customer on the gateway's page — which
 * happens *after* the order is created. See the payment method
 * selector's docblock for the full argument.
 *
 * **5. The checkout page holds the payment *choice*, and nothing else.**
 *
 * No wallet radio buttons, no card fields, no transfer reference. The
 * customer's payment details are entered on the **gateway's own page**
 * — which is where the customer is looking at the merchant, the order
 * and the exact amount they are about to send.
 *
 * So the split is:
 *
 *   • **The checkout page** — the method selection, and nothing more.
 *   • **The gateway page** — the card details, or the bKash/Nagad
 *     confirmation, next to the amount.
 *
 * **6. The card details never leave the browser.**
 *
 * The card details are collected by the gateway, not by this shop, and
 * they are never in the request body below — nor in the form's
 * `FormData`. The server refuses them outright as well
 * (`checkoutSchema` rejects any body carrying a card key, and
 * `gatewaySettleSchema` is `.strict()`), so a leak would be a loud
 * `400` rather than a silent strip.
 *
 * A shop that stores a card number has breached PCI DSS. This one
 * stores the payment *method* and the gateway's own reference, and
 * nothing else.
 */

/**
 * The props for the form.
 */
export type CheckoutFormProps = {
  readonly cart: CartView;
  /** The customer's name, prefilled into the address. */
  readonly customerName: string;
  /**
   * The customer's mobile number, prefilled into the address.
   *
   * It comes from the **account**, not from the address form, so a
   * customer who has already given the shop their number does not have
   * to give it again.
   */
  readonly customerPhone?: string | null;
  /**
   * The customer's saved delivery address, if they have one.
   *
   * This is the payoff of the settings page: the address form is
   * pre-filled from the account, so a customer who has already told us
   * where they live does not type it again on every order.
   *
   * It is a **pre-fill**, not a lock. Every field stays editable, and
   * the address the customer submits is what the order carries — the
   * saved address is never written onto the order server-side. The
   * customer always has the last word about where a parcel goes.
   */
  readonly savedAddress?: {
    readonly fullName: string;
    readonly phone: string;
    readonly addressLine1: string;
    readonly addressLine2?: string;
    readonly city: string;
    readonly district: string;
    readonly postalCode: string;
  } | null;
  /**
   * The discount codes that are live right now.
   *
   * The checkout lists them so a customer who has seen a campaign can
   * find the code without having to remember it — and apply it *before*
   * the order is placed, because a code cannot be applied after it.
   */
  readonly coupons?: readonly PublicCoupon[];
  /**
   * A code to pre-fill the discount field with.
   */
  readonly suggestedCode?: string | null;
};

export function CheckoutForm({
  cart,
  customerName,
  customerPhone = null,
  savedAddress = null,
  coupons = [],
  suggestedCode,
}: CheckoutFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string>
  >({});
  const [conflicts, setConflicts] = useState<
    { title: string; message: string; remedy: string }[]
  >([]);
  const [confirmed, setConfirmed] = useState(false);

  /**
   * The chosen payment method.
   *
   * Defaults to `COD` — the platform's default method (DECISIONS.md
   * #4) and the one most of the shop's customers use.
   *
   * The checkout offers **two** choices, and both of them are real
   * `PaymentMethod` values: `COD` for cash on delivery, and `CARD` for
   * the bundled online option. The online option records `CARD`
   * because the operator — bKash, Nagad or a card network — is chosen
   * by the customer on SSLCOMMERZ's own page, which happens *after*
   * the order is created. See the payment method selector's docblock
   * for the full argument.
   */
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodInput>(
    "COD",
  );

  /**
   * Whether the order is being placed.
   *
   * This is the **double-submit guard**: a second press while the order
   * is being created would place a second order, and the customer would
   * be charged twice for one basket.
   */
  const [isRedirecting, setIsRedirecting] = useState(false);

  /**
   * Whether the customer is on their way to the real SSLCOMMERZ
   * gateway.
   *
   * The SSLCOMMERZ flow is a **redirect**: the customer leaves the shop
   * entirely, pays on the gateway's own page, and comes back through
   * `/payment/success`, `/payment/fail` or `/payment/cancel`. There is
   * no modal to show over this page, because the page that collects the
   * card details is the gateway's, not ours.
   *
   * This flag exists so the button says the right thing while the
   * redirect is in flight — "Opening secure payment…" rather than
   * "Placing your order…". It is set **only** once the server has
   * confirmed that a gateway session was minted, so a cash order — which
   * never touches the gateway — never claims to be opening a payment.
   */
  const [isOpeningGateway, setIsOpeningGateway] = useState(false);

  const blockingConflicts = cart.conflicts.filter(
    (conflict) => conflict.severity === "BLOCK",
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // The customer is being handed over to the gateway. A second press
    // would open a second session, and the customer would end up paying
    // the same order twice.
    if (isRedirecting) return;

    const form = event.currentTarget;
    const data = new FormData(form);

    const address = {
      fullName: String(data.get("fullName") ?? ""),
      phone: String(data.get("phone") ?? ""),
      addressLine1: String(data.get("addressLine1") ?? ""),
      addressLine2: String(data.get("addressLine2") ?? "") || undefined,
      city: String(data.get("city") ?? ""),
      district: String(data.get("district") ?? ""),
      postalCode: String(data.get("postalCode") ?? ""),
      notes: String(data.get("notes") ?? "") || undefined,
    };

    startTransition(async () => {
      setError(null);
      setFieldErrors({});

      /**
       * The button's "in flight" state.
       *
       * Set **now**, before the request, because it is also the
       * double-submit guard: a second press while the order is being
       * created would place a second order.
       *
       * The button's *label* is chosen further down, where the server
       * has told us whether a gateway session was minted. A cash order
       * must not say "Opening secure payment…" on its way to a page
       * that involves no payment at all.
       */
      setIsRedirecting(true);

      try {
        /**
         * The request body.
         *
         * The address and the payment method. **No payment details.**
         *
         * Nothing about the payment is collected here at all. The
         * customer types their card number, or their bKash and Nagad
         * confirmation, on the **gateway's own page** — after the
         * order exists. And no card key appears here: `checkoutSchema`
         * refuses the four card keys outright, so a leak would be a
         * loud `400` rather than a silent strip.
         */
        const response = await fetch("/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shippingAddress: address,
            paymentMethod,
            confirmConflicts: confirmed,
            note: String(data.get("note") ?? "") || undefined,
          }),
        });

        const result = (await response.json()) as {
          ok: boolean;
          data?: {
            order?: CheckoutOrderResponse & {
              gateway?: GatewaySessionPayload | null;
            };
          };
          error?: {
            message: string;
            details?: {
              fieldErrors?: Record<string, string[]>;
              conflicts?: { title: string; message: string; remedy: string }[];
            };
          };
        };

        if (!result.ok) {
          setError(result.error?.message ?? "We could not place your order.");
          setIsRedirecting(false);
          setIsOpeningGateway(false);

          const details = result.error?.details;

          if (details?.fieldErrors) {
            setFieldErrors(
              Object.fromEntries(
                Object.entries(details.fieldErrors).map(([key, messages]) => [
                  key,
                  messages?.[0] ?? "This value is not valid.",
                ]),
              ),
            );
          }

          if (details?.conflicts) {
            setConflicts(details.conflicts);
          }

          return;
        }

        const order = result.data?.order;

        /**
         * The order is placed. Now, does it need a gateway session?
         *
         * The **server** decides: it mints a session for every non-COD
         * order, and none for a cash order. So the form reads the
         * response rather than deciding from the payment method it
         * happens to have selected — one source of truth, and the two
         * cannot drift.
         *
         * **A cash order ends here.** The order is placed, the stock is
         * reserved, and the customer goes straight to their order
         * page. Nothing is charged and nothing is pending but the
         * courier.
         */
        if (!order?.gateway) {
          router.push(orderConfirmationPath(order));
          router.refresh();
          return;
        }

        /**
         * The SSLCOMMERZ handover.
         *
         * The order is placed and the money is not. The customer is
         * handed over to the gateway's own payment page — where the
         * gateway presents bKash, Nagad and the card networks together
         * — and comes back through `/payment/success` (or
         * `/payment/fail`, `/payment/cancel`) when they are done.
         *
         * The redirect URL comes from the **server** — it is the
         * gateway's `GatewayPageURL`, returned by the gateway itself. The
         * client never composes it, so a tampered client cannot point
         * the customer at somebody else's checkout page.
         *
         * If the session cannot be opened, the order is still placed and
         * still reserved — so the customer is sent to their order page,
         * where the payment can be retried, rather than left staring at
         * a checkout form for an order that already exists.
         */
        const sessionResponse = await fetch("/api/payment/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId: order.gateway.orderId }),
        });

        const sessionResult = (await sessionResponse.json()) as {
          ok: boolean;
          data?: { gatewayPageUrl?: string };
          error?: { message?: string };
        };

        if (!sessionResult.ok || !sessionResult.data?.gatewayPageUrl) {
          /**
           * The session could not be opened.
           *
           * The order **is** placed and **is** reserved, so the customer
           * is sent to their order page — where the payment can be
           * retried — rather than left on a checkout form for an order
           * that already exists. The cart is empty at this point, so
           * the checkout page would show a form that cannot be
           * submitted again.
           */
          router.push(orderConfirmationPath(order));
          router.refresh();
          return;
        }

        /**
         * The gateway session is open and the customer is on their way.
         *
         * Only now does the button say "Opening secure payment…" — the
         * handover really is imminent, so the promise is kept.
         */
        setIsOpeningGateway(true);

        /**
         * The handover.
         *
         * `window.location.assign` rather than `router.push`: the
         * gateway is a different site, and Next's client-side router
         * cannot navigate to one. A full document navigation is the
         * correct mechanism, and it is what makes the browser's
         * back-button behave the way a customer expects after a payment.
         */
        window.location.assign(sessionResult.data.gatewayPageUrl);
      } catch {
        setError("We could not reach the server. Your order was not placed.");
        setIsRedirecting(false);
        setIsOpeningGateway(false);
      }
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start"
    >
      {/*
        ── The left column ────────────────────────────────────────────────

        Address, payment and note in one aligned column. The sections
        are separated by a rule rather than by a wall of white space,
        so the column reads as one continuous form instead of three
        floating blocks — which is what "properly aligned on the left"
        means in practice.
      */}
      <div className="space-y-8">
        <section aria-labelledby="address-heading">
          <h2
            id="address-heading"
            className="text-sm font-bold uppercase tracking-wider text-foreground"
          >
            Delivery address
          </h2>

          <div className="mt-4 space-y-4">
            <Field
              id="fullName"
              label="Full name"
              defaultValue={savedAddress?.fullName ?? customerName}
              error={fieldErrors.fullName}
              autoComplete="name"
              required
            />

            <Field
              id="phone"
              label="Mobile number"
              type="tel"
              defaultValue={savedAddress?.phone ?? customerPhone ?? undefined}
              error={fieldErrors.phone}
              autoComplete="tel"
              hint="The courier will call this number before delivery."
              required
            />

            <Field
              id="addressLine1"
              label="Street address"
              defaultValue={savedAddress?.addressLine1}
              error={fieldErrors.addressLine1}
              autoComplete="address-line1"
              required
            />

            <Field
              id="addressLine2"
              label="Apartment, floor, landmark (optional)"
              defaultValue={savedAddress?.addressLine2}
              error={fieldErrors.addressLine2}
              autoComplete="address-line2"
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="city"
                label="City"
                defaultValue={savedAddress?.city}
                error={fieldErrors.city}
                autoComplete="address-level2"
                required
              />

              <Field
                id="district"
                label="District"
                defaultValue={savedAddress?.district}
                error={fieldErrors.district}
                autoComplete="address-level1"
                required
              />
            </div>

            <Field
              id="postalCode"
              label="Postal code"
              defaultValue={savedAddress?.postalCode}
              error={fieldErrors.postalCode}
              autoComplete="postal-code"
              inputMode="numeric"
              required
            />

            {/*
              The link to the settings, shown only when there is
              something to edit.

              A customer who has saved an address and then moved would
              otherwise have to find this page by themselves. A customer
              who has never saved one has nothing to edit, so the link
              would be noise.
            */}
            {savedAddress ? (
              <p className="text-[11px] text-foreground-muted">
                Pre-filled from your saved address.{" "}
                <Link
                  href="/account/settings"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Change it
                </Link>
                .
              </p>
            ) : null}
          </div>
        </section>

        {/* ── The payment ────────────────────────────────────────────── */}
        <section aria-labelledby="payment-heading">
          <h2
            id="payment-heading"
            className="text-sm font-bold uppercase tracking-wider text-foreground"
          >
            Payment
          </h2>

          {/*
            The payment selection.

            The **only** payment content on this page. It is a single
            flat row of **two** method cards — Cash on Delivery and
            Online Payment (SSLCommerz) — with no inline wallet
            selector, no card fields and no transfer reference.

            bKash, Nagad and the card networks are **bundled** into the
            online option rather than listed separately: the customer
            picks them on the gateway's own page, where the gateway can
            actually tell them which of those their card or wallet can
            use. Asking here would be asking a question this shop
            cannot answer yet.
          */}
          <PaymentMethodSelector
            value={paymentMethod}
            onChange={setPaymentMethod}
          />
        </section>

        {/* ── The note ───────────────────────────────────────────────── */}
        <section aria-labelledby="note-heading">
          <h2
            id="note-heading"
            className="text-sm font-bold uppercase tracking-wider text-foreground"
          >
            Order note (optional)
          </h2>

          <div className="mt-4">
            <label htmlFor="note" className="sr-only">
              Order note
            </label>
            <textarea
              id="note"
              name="note"
              rows={3}
              maxLength={500}
              placeholder="Anything the courier should know?"
              className="w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground transition-colors placeholder:text-foreground-muted focus-visible:border-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>
        </section>
      </div>

      {/* ── The summary ──────────────────────────────────────────────── */}
      <aside className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)] lg:sticky lg:top-24">
        <h2 className="text-sm font-bold text-foreground">Order summary</h2>

        <ul className="mt-4 space-y-3">
          {cart.items.map((line) => (
            <li key={line.id} className="flex items-start justify-between gap-3 text-sm">
              <span className="min-w-0 text-foreground-muted">
                <span className="font-medium text-foreground">
                  {line.quantity} ×
                </span>{" "}
                {line.product.name}
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {formatPaisa(line.lineTotalPaisa)}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 space-y-2.5 border-t border-border pt-4 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-foreground-muted">Payment method</span>
            <span className="font-medium text-foreground">
              {paymentMethod === "COD"
                ? "Cash on Delivery"
                : "Online Payment (SSLCommerz)"}
            </span>
          </div>

          <div className="flex justify-between gap-4">
            <span className="text-foreground-muted">Subtotal</span>
            <span className="font-medium tabular-nums text-foreground">
              {formatPaisa(cart.subtotalPaisa)}
            </span>
          </div>

          {/*
            The discount line.

            It appears only when a code is applied and is worth something.
            A row reading "৳0" is noise — it sends the customer looking
            for a discount that is not there.

            The figure is the **server's**, and it is the same figure the
            order will be created with. The client never re-derives what
            a code is worth.
          */}
          {cart.coupon && cart.coupon.discountPaisa > 0 ? (
            <div className="flex justify-between gap-4">
              <span className="text-foreground-muted">
                Discount
                <span className="ml-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                  {cart.coupon.code}
                </span>
              </span>
              <span className="font-medium tabular-nums text-brand-700 dark:text-brand-300">
                −{formatPaisa(cart.coupon.discountPaisa)}
              </span>
            </div>
          ) : null}

          <div className="flex justify-between gap-4">
            <span className="text-foreground-muted">Delivery</span>
            <span className="font-medium tabular-nums text-foreground">
              Confirmed on placement
            </span>
          </div>
        </div>

        <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-border pt-4">
          <span className="text-sm font-semibold text-foreground">Total</span>
          <span className="text-lg font-bold tabular-nums text-foreground">
            {/*
              The goods' total, after the discount. Delivery is added by
              the server when the order is placed, and it is free above
              the threshold — so this figure is deliberately *not* the
              final amount. It is the part the customer can already see
              the effect of.
            */}
            {formatPaisa(
              cart.subtotalPaisa - (cart.coupon?.discountPaisa ?? 0),
            )}
          </span>
        </div>

        {/* ── The discount code helper ─────────────────────────────── */}
        <CouponBox
          applied={cart.coupon}
          available={coupons}
          suggestedCode={suggestedCode}
        />

        {error ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            {error}
          </div>
        ) : null}

        {/* ── The conflict acknowledgement ─────────────────────────── */}
        {conflicts.length > 0 || blockingConflicts.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-red-700">
              One thing to check first
            </h3>

            <ul className="mt-2 space-y-3">
              {(conflicts.length > 0
                ? conflicts
                : blockingConflicts.map((conflict) => ({
                    title: conflict.title,
                    message: conflict.message,
                    remedy: conflict.remedy,
                  }))
              ).map((conflict, index) => (
                <li key={`${conflict.title}-${index}`}>
                  <p className="text-xs font-semibold text-red-800">
                    {conflict.title}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-red-700">
                    {conflict.message}
                  </p>
                  <p className="mt-1 text-[11px] font-medium text-red-800">
                    {conflict.remedy}
                  </p>
                </li>
              ))}
            </ul>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              <span className="text-[11px] leading-relaxed text-red-800">
                I have read this and still want to place the order.
              </span>
            </label>
          </div>
        ) : null}

        <div className="mt-5">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            disabled={
              isPending ||
              isRedirecting ||
              (blockingConflicts.length > 0 && !confirmed)
            }
          >
            {/*
              The label follows the truth of the moment.

              A cash order never touches the gateway, so it must never
              claim to be "Opening secure payment…" — it says
              "Placing your order…" the whole way to its order page.
            */}
            {isOpeningGateway
              ? "Opening secure payment…"
              : isPending || isRedirecting
                ? "Placing your order…"
                : "Place order"}
          </Button>
        </div>

        {blockingConflicts.length > 0 && !confirmed ? (
          <p className="mt-2 text-center text-[11px] text-red-600">
            Please confirm the warning above to continue.
          </p>
        ) : null}

        {/*
          What happens next.

          For an online payment, pressing the button places the order
          and then opens SSLCOMMERZ's own secure payment page, where the
          customer chooses between bKash, Nagad and the card networks.

          The payment selector already says this in full, so this line
          is a short reminder next to the button that causes it — not a
          second explanation of the same thing.
        */}
        {paymentMethod === "COD" ? null : (
          <p className="mt-3 text-center text-[11px] leading-relaxed text-foreground-muted">
            You will be taken to our secure SSLCommerz payment page to
            complete the payment.
          </p>
        )}

        <p className="mt-3 text-center text-[11px] text-foreground-muted">
          <Link
            href="/cart"
            className="underline underline-offset-2 hover:text-foreground-muted"
          >
            Back to your cart
          </Link>
        </p>
      </aside>
    </form>
  );
}

/**
 * One labelled field.
 */
function Field({
  id,
  label,
  type = "text",
  error,
  hint,
  defaultValue,
  autoComplete,
  inputMode,
  required,
}: {
  readonly id: string;
  readonly label: string;
  readonly type?: string;
  readonly error?: string;
  readonly hint?: string;
  readonly defaultValue?: string;
  readonly autoComplete?: string;
  readonly inputMode?: "text" | "numeric" | "tel" | "email" | "decimal" | "search" | "url" | "none";
  readonly required?: boolean;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-semibold text-foreground-muted"
      >
        {label}
      </label>

      <input
        id={id}
        name={id}
        type={type}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        inputMode={inputMode}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={[
          "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
          "transition-colors placeholder:text-foreground-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          error
            ? "border-red-300 focus-visible:ring-red-400"
            : "border-border focus-visible:border-brand-400",
        ].join(" ")}
      />

      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {hint ? (
        <p id={hintId} className="mt-1.5 text-[11px] text-foreground-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
