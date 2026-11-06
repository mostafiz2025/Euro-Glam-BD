"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CardDetailsForm,
  EMPTY_CARD_DETAILS,
  isCardDetailsValid,
  validateCardDetails,
  type CardDetails,
} from "@/components/commerce/card-details-form";
import { PaymentProviderGrid } from "@/components/commerce/payment-provider-grid";
import {
  EMPTY_TRANSFER_DETAILS,
  isTransferDetailsValid,
  normaliseTransferDetails,
  PaymentTransferForm,
  validateTransferDetails,
  type TransferDetails,
} from "@/components/commerce/payment-transfer-form";
import { Button, IconButton } from "@/components/ui/button";
import { CloseIcon, InfoIcon, ShieldIcon, TagIcon } from "@/components/ui/icons";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { formatPaisa, formatPaisaBare } from "@/lib/format/money";
import {
  NET_BANKING_RAILS,
  gatewayTabForMethod,
  railsForMethod,
} from "@/lib/format/payment-rails";
import { paymentMethodLabel } from "@/lib/format/payment";
import type { ApiEnvelope } from "@/lib/format/types";
import type { GatewaySessionPayload } from "@/lib/payments/session";

/**
 * The local payment window.
 *
 * ── What this component is ────────────────────────────────────────────────
 *
 * A payment window for an order that the **shop itself** settles. It
 * shows the merchant, the payment rails, the method the order was
 * recorded with, the amount — and it collects the details that method
 * needs.
 *
 * ── Where it sits in the online flow ──────────────────────────────────────
 *
 * An order placed with **Online Payment** at the checkout does **not**
 * come through here. That order is handed to SSLCOMMERZ's own hosted
 * page, where the customer chooses bKash, Nagad or a card network and
 * enters their details on the gateway's page — the shop never sees a
 * card number at all.
 *
 * This window is for the orders the shop still settles **locally**:
 *
 *   • An order whose method is recorded as `BKASH` or `NAGAD` — a
 *     transfer into the shop's own merchant account, settled by
 *     quoting the TrxID. The order page's "Pay now" button opens this.
 *   • The sandbox simulation of a card payment.
 *
 * Both paths are reachable, and both settle through the same endpoint,
 * so the reconciliation rules are the same either way.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The amount is the server's.**
 *
 * The modal renders `session.amountPaisa` and never computes it. That
 * figure came from the server's own order-total calculation, inside the
 * order transaction. The modal has no idea what the products cost, and
 * it must not be able to — a payment window that computed its own amount
 * would be a window the customer could edit.
 *
 * **2. This is where the payment details are collected.**
 *
 * The checkout page holds the payment **choice** and nothing else. The
 * card fields and the transfer reference are collected here, next to the
 * amount — because that is where the customer is actually looking at the
 * merchant and the exact total they are about to send, which is the
 * moment they have the bKash or Nagad confirmation screen in their hand.
 *
 * So the two paths differ:
 *
 *   • **Card** — the customer types the card number, the expiry, the CVC
 *     and the holder name. The details are checked **in the browser** and
 *     **never sent**. PAY is gated on the card being well-formed.
 *
 *   • **Mobile banking** — the customer types the number they sent the
 *     transfer from and the TrxID from the confirmation screen. These
 *     **are** sent, with the settle request, and the server writes them
 *     onto the order as it marks it `PAID`.
 *
 * **3. A simulated failure is a successful request.**
 *
 * The settle endpoint answers a declined payment with **200** and an
 * `attempt.outcome` of `FAILED`, because the request was well-formed and
 * correctly authorised — the *payment* failed, not the request. So the
 * modal reads `data.attempt.outcome` to decide what to show, and its
 * `!result.ok` branch is reserved for real errors: not signed in, not
 * your order, session expired.
 *
 * **4. A failure changes nothing about the order.**
 *
 * The order is still `PENDING` and the stock is still reserved. The
 * modal says so, because it is true and because it is what makes the
 * retry safe: the customer can press the button again, on the same
 * order, with the same session.
 *
 * **5. The modal owns the request; the form owns the navigation.**
 *
 * The checkout form also owns the redirect for a cash-on-delivery
 * order, and one component owning the redirect is simpler than two.
 * So the modal asks to be told what happened, and the form does the
 * navigating.
 *
 * **6. The provider grid is a confirmation, not a control.**
 *
 * The grid shows every provider the reference design shows, but only
 * the rail the server recorded is selectable. The reason is not a
 * limitation of the design — it is the reconciliation guard. See
 * `src/components/commerce/payment-provider-grid.tsx` for the full
 * argument; the short version is that `settleGatewayPayment` reads
 * `order.paymentMethod` from the database, so a grid that could switch
 * the method would let the customer desynchronise the order from its
 * own record.
 *
 * **7. The card details never leave the browser.**
 *
 * They are in scope in this component — the customer types them here —
 * and they are deliberately **not** in the settle request body. A card
 * number that reached the server would be a PCI DSS breach, so the
 * exclusion is structural rather than disciplinary: `gatewaySettleSchema`
 * is `.strict()`, so a stray card field would be rejected with a 400
 * rather than silently sent.
 *
 * This component is the first line of that defence. The schema is the
 * backstop.
 *
 * **8. The window is opaque, and it sits above everything.**
 *
 * A payment window that lets the page show through is not a payment
 * window — the customer cannot tell where the amount ends and the
 * checkout form begins, and the button they are about to press is not
 * unambiguously *the* button. So the panel carries a solid `bg-surface`
 * and the scrim is `bg-black/60` with a `backdrop-blur-sm`, at
 * `z-50`. The three tabs and the PAY button are always fully visible:
 * the tab strip's underline is drawn on the strip's own border rather
 * than clipped by it, and the payment bar sits outside the scroll
 * container so the amount and the button never scroll away.
 */

/**
 * The props for the window.
 */
export type PaymentGatewayModalProps = {
  /** The gateway session the server created. */
  readonly session: GatewaySessionPayload;
  /** Called when the payment succeeds. */
  readonly onPaid: () => void;
  /** Called when the customer closes the window without paying. */
  readonly onClose: () => void;
};

/**
 * The shape the settle endpoint answers with.
 */
type SettleResponse = {
  readonly order: {
    readonly orderId: string;
    readonly orderNumber: string;
    readonly paymentStatus: string;
    readonly transactionId: string | null;
  };
  readonly attempt: {
    readonly id: string;
    readonly outcome: "SUCCESS" | "FAILED";
    readonly failureMessage: string | null;
  };
};

export function PaymentGatewayModal({
  session,
  onPaid,
  onClose,
}: PaymentGatewayModalProps) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The card details.
   *
   * **State, never a form field.** They are never given a `name`
   * attribute, so a `FormData` sweep cannot pick them up; and the settle
   * body below is an explicit allow-list that does not mention them.
   */
  const [cardDetails, setCardDetails] = useState<CardDetails>(
    EMPTY_CARD_DETAILS,
  );

  /**
   * The transfer details, for a mobile-banking order.
   */
  const [transfer, setTransfer] = useState<TransferDetails>(
    EMPTY_TRANSFER_DETAILS,
  );

  /**
   * Whether the customer has tried to pay.
   *
   * Before the first attempt the fields are silent until the customer
   * leaves one. After it, every problem is shown at once — otherwise the
   * customer fixes one field, presses the button again, and is told about
   * the next one, one round trip at a time.
   */
  const [submitted, setSubmitted] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * The tab the window opens on.
   *
   * Derived from the method the **server** recorded, not from anything
   * the customer did in this window.
   */
  const activeTab = gatewayTabForMethod(session.paymentMethod);

  /**
   * The mobile-banking rails, resolved against this order's method.
   *
   * The recorded rail stays available; the other one is disabled with
   * the reason "Not the method chosen at checkout."
   */
  const mobileRails = railsForMethod(session.paymentMethod);

  /**
   * Whether this order is settled by a mobile-banking transfer.
   *
   * Read from the **server's** method, not from a client-supplied one.
   */
  const isMobileBanking =
    session.paymentMethod === "BKASH" || session.paymentMethod === "NAGAD";

  /**
   * The wallet's name, for the labels and the reassurance.
   */
  const operatorName =
    session.paymentMethod === "NAGAD" ? "Nagad" : "bKash";

  /**
   * The card validation errors.
   *
   * Computed on every render, so they cannot go stale.
   */
  const cardErrors = useMemo(
    () => validateCardDetails(cardDetails),
    [cardDetails],
  );

  /**
   * The transfer validation errors.
   */
  const transferErrors = useMemo(
    () => validateTransferDetails(transfer),
    [transfer],
  );

  /**
   * Whether the details this method needs are complete.
   *
   * A card payment cannot settle with a malformed card number, and a
   * mobile-banking payment cannot settle without a transfer reference —
   * an order that settles with no TrxID is an order the shop cannot
   * reconcile against a merchant statement.
   *
   * So PAY is gated, and the gate is **client-side** for the card because
   * the server never sees the card — it cannot check it.
   */
  const detailsAreReady = isMobileBanking
    ? isTransferDetailsValid(transfer)
    : session.paymentMethod === "CARD"
      ? isCardDetailsValid(cardDetails)
      : true;

  /**
   * Move focus into the window when it opens.
   *
   * The window is mounted only while it is open — the checkout form
   * renders it conditionally — so this runs once, on mount.
   */
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  /**
   * Close on `Escape`.
   *
   * The same affordance as the scrim, so there are two ways out and
   * neither traps the customer.
   */
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  /**
   * Lock the body behind the window.
   *
   * Without this the page scrolls under the window while the customer is
   * reading the amount — which is exactly the moment they are deciding
   * whether to pay.
   */
  useEffect(() => {
    const previous = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  async function settle(outcome: "SUCCESS" | "FAILED"): Promise<void> {
    if (isPending) return;

    /*
     * The gate.
     *
     * A successful settle needs the details this method requires. The
     * button is disabled until they are there, but the check is repeated
     * here — a disabled button is a courtesy, and a courtesy is not a
     * guarantee.
     */
    if (outcome === "SUCCESS" && !detailsAreReady) {
      setSubmitted(true);
      setError(
        isMobileBanking
          ? "Please enter your sender number and TrxID before paying."
          : "Please check your card details before paying.",
      );
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      /**
       * The transfer reference, for a mobile-banking order.
       *
       * Normalised first — the sender number into the local
       * `01XXXXXXXXX` form the operator prints on its statement, and the
       * TrxID into upper case. Normalising in the browser means the
       * server stores the same string the statement carries, so the two
       * match when the shop reconciles the transfer.
       *
       * It is `undefined` for every other method, and the server
       * **refuses** a transfer reference on a card or cash order — so
       * the key is absent from the body entirely, rather than sent as
       * `undefined`.
       */
      const transferReference = isMobileBanking
        ? normaliseTransferDetails(transfer)
        : undefined;

      const response = await fetch(
        `/api/orders/${session.orderId}/payment/settle`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          /**
           * The request body.
           *
           * The session token, the outcome, and — for a mobile-banking
           * order — the transfer reference. **No card key.**
           *
           * The card details are **in scope in this component** — the
           * customer typed them here — and they are deliberately **not**
           * in this object. A card number that reached the server would
           * be a PCI DSS breach, so the exclusion is structural rather
           * than disciplinary: `gatewaySettleSchema` is `.strict()`, so
           * a stray card field here would be rejected with a 400 rather
           * than silently sent.
           *
           * This component is the first line of that defence. The
           * schema is the backstop.
           */
          body: JSON.stringify({
            sessionId: session.sessionId,
            outcome,
            ...(transferReference ?? {}),
          }),
        },
      );

      const payload = (await response.json()) as ApiEnvelope<SettleResponse>;

      // A real error: not signed in, not your order, or the session has
      // expired. The customer cannot fix these by pressing again.
      if (!payload.ok) {
        setError(payload.error.message);
        setIsPending(false);
        return;
      }

      // The gateway declined. The order is untouched, so the customer
      // can simply try again.
      if (payload.data.attempt.outcome === "FAILED") {
        setError(
          payload.data.attempt.failureMessage ??
            "The payment was declined by the gateway. Please try again.",
        );
        setIsPending(false);
        return;
      }

      setIsPending(false);
      onPaid();
    } catch {
      // The network failed. The order is still reserved and the session
      // is still live, so the customer can retry.
      setError(
        "We could not reach the payment gateway. Your order is still reserved — please try again.",
      );
      setIsPending(false);
    }
  }

  /**
   * The three tabs.
   *
   * The tab contents are built here rather than inside the `Tabs`
   * element so that the panel markup stays readable.
   */
  const tabs: TabItem[] = [
    {
      id: "cards",
      label: "Cards",
      content: (
        <div className="space-y-4">
          {/*
            The card networks.

            The networks this shop accepts, shown so the customer can
            see *what kind* of card the window expects.
          */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
              Accepted cards
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PaymentNetworkPill label="VISA" />
              <PaymentNetworkPill label="Mastercard" circles />
              <PaymentNetworkPill label="AMEX" />
              <PaymentNetworkPill label="DISCOVER" />
            </div>
          </div>

          {/*
            The card entry.

            The customer types the card here, in the window, next to the
            amount. The details are checked in the browser and **never
            sent** — the settle body carries the session token, the
            outcome, and (for a mobile-banking order) the transfer
            reference, and nothing else.
          */}
          <CardDetailsForm
            value={cardDetails}
            onChange={setCardDetails}
            errors={cardErrors}
            submitted={submitted}
          />
        </div>
      ),
    },
    {
      id: "mobile",
      label: "Mobile Banking",
      content: (
        <div className="space-y-4">
          <PaymentProviderGrid
            rails={mobileRails}
            selectedRailId={session.paymentMethod}
            legend="Mobile banking provider"
            name="gateway-mobile-rail"
          />

          {/*
            The confirmation.

            The customer is told which wallet their order is on. It is
            not a choice — the method was decided at checkout and
            recorded on the order — but it is worth saying out loud,
            because the grid above shows other providers too.
          */}
          <p className="rounded-xl bg-surface-muted px-3 py-2.5 text-xs leading-relaxed text-foreground-muted">
            You are paying with{" "}
            <span className="font-semibold text-foreground">
              {paymentMethodLabel(session.paymentMethod)}
            </span>
            . Send the exact total to our {operatorName} merchant number.
            We will verify the transfer before dispatching your order.
          </p>

          {/*
            The transfer entry.

            The sender number and the TrxID, collected here — while the
            customer is looking at the amount they are about to send —
            and sent with the settle request. The server writes them
            onto the order as it marks it `PAID`.
          */}
          <PaymentTransferForm
            value={transfer}
            onChange={setTransfer}
            errors={transferErrors}
            submitted={submitted}
            operatorName={operatorName}
          />
        </div>
      ),
    },
    {
      id: "net",
      label: "Net Banking",
      content: (
        <div className="space-y-4">
          {/*
            The net-banking panel.

            The tab is present and clickable, and the banks are shown,
            and **none of them is selectable**. There is no net-banking
            rail in the `PaymentMethod` enum, no bank-reference column
            and no merchant account to reconcile against — so a tab the
            customer could actually use would be worse than no tab at
            all.

            The message says so plainly rather than leaving the customer
            to work it out from five greyed-out tiles.
          */}
          <div className="rounded-[var(--radius-card)] border border-border bg-surface-muted p-4">
            <p className="text-sm font-semibold text-foreground">
              Net banking is not available yet
            </p>
            <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
              We do not settle net-banking transfers yet. Please use bKash,
              Nagad, a card, or cash on delivery.
            </p>
          </div>

          <PaymentProviderGrid
            rails={NET_BANKING_RAILS}
            selectedRailId=""
            legend="Net banking bank"
            name="gateway-net-rail"
          />
        </div>
      ),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 sm:p-6"
      role="presentation"
    >
      {/*
        The scrim.

        It is **after** the panel in the DOM, on purpose. It is an
        absolutely-positioned `<button>`, so as the first tab stop it
        would take focus before the window's own content — the
        opposite of what a modal should do. In this order the panel's
        content comes first in the tab sequence, and the scrim is
        reached only after the customer has tabbed through the
        window.

        Clicking it still closes the window — the same affordance as
        `Escape`.

        **The backdrop is opaque enough to kill the bleed-through.**
        `bg-black/60` plus a `backdrop-blur-sm` is the standard recipe:
        the black carries the contrast and the blur carries the
        separation. The earlier `bg-neutral-900/40` was both too
        transparent *and* washed with a hue that did not belong to
        this palette, which let the checkout page read through the
        window and made the panel's own edges hard to place.
      */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-gateway-title"
        tabIndex={-1}
        className={[
          "relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden",
          // A solid, opaque surface. The panel must never be
          // translucent — a payment window that shows the checkout
          // page through it is not a payment window.
          "rounded-2xl border border-border bg-surface",
          // A shadow deep enough to lift the panel clear of the
          // backdrop, so the edge is unmistakable.
          "shadow-lift focus:outline-none",
        ].join(" ")}
      >
        {/* ── The header ─────────────────────────────────────────────── */}
        {/*
          `bg-surface` is repeated here rather than inherited, so the
          header is opaque in its own right. It matters because the
          panel is `overflow-hidden` with a rounded corner: without an
          explicit background the header's rounded top corner can let
          the backdrop show through at the very edge.
        */}
        <div className="shrink-0 border-b border-border bg-surface px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  id="payment-gateway-title"
                  className="font-serif text-lg font-bold text-foreground"
                >
                  {session.merchantName}
                </h2>

                {/*
                  The sandbox chip.

                  The honest thing about a simulation is to say it where
                  the customer will actually read it — and the reference
                  design puts its "DEMO" mark in exactly this spot. So
                  the merchant's name stands in for "DEMO", and this chip
                  says what the window really is.
                */}
                <span className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-warning">
                  Sandbox
                </span>
              </div>

              <p className="mt-0.5 text-xs text-foreground-muted">
                Order {session.orderNumber}
              </p>
            </div>

            {/*
              The close button.

              `IconButton` **requires** a `label`, which becomes the
              accessible name. The previous bare `&times;` glyph
              announced as "button" — which tells a screen reader
              nothing.
            */}
            <IconButton
              label="Close the payment window"
              onClick={onClose}
              className="-mr-2 -mt-1"
            >
              <CloseIcon width={18} height={18} />
            </IconButton>
          </div>

          {/*
            The quick navigation.

            **Support** and **FAQ** are non-navigating pills. There are no
            such pages in this shop, and a broken link in the middle of a
            payment is a dead end at the worst possible moment — so they
            are informational. The `sr-only` note says why, for anyone
            who wonders why they do not go anywhere.

            **Offers** is a real link, to the real `/products` page,
            where discounted prices are already rendered
            storefront-side via `discountPercent`. So it goes somewhere
            true.

            A `/help` page with `#support`, `#faq` and `#offers` anchors
            would make all three real links. That is a bounded
            follow-up, and it is called out here rather than assumed.
          */}
          <nav aria-label="Payment help" className="mt-3 flex flex-wrap gap-2">
            <QuickNavPill icon={<InfoIcon width={13} height={13} />}>
              Support
              <span className="sr-only">
                {" "}
                — information only. There is no support page in this
                shop yet.
              </span>
            </QuickNavPill>

            <QuickNavPill icon={<InfoIcon width={13} height={13} />}>
              FAQ
              <span className="sr-only">
                {" "}
                — information only. There is no FAQ page in this shop
                yet.
              </span>
            </QuickNavPill>

            <Link
              href="/products"
              className={[
                "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1",
                "text-xs font-medium text-foreground-muted transition-colors",
                "hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              ].join(" ")}
            >
              <TagIcon width={13} height={13} />
              Offers
            </Link>
          </nav>
        </div>

        {/*
          The body.

          `min-h-0` on the scroll container is the single most common
          mobile-layout bug here: without it the flex child refuses to
          shrink, and the footer is pushed off-screen. `dvh` rather than
          `vh`, because mobile Safari's `vh` does not track the
          collapsing URL bar.
        */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-surface px-5 py-4">
          {/* ── The tabs ────────────────────────────────────────────── */}
          {/*
            The `key` is not decoration.

            `Tabs` seeds its selection with a **one-time**
            `useState(defaultSelectedId ?? …)`, which does not respond to
            a changed prop. The modal is mounted per session, so
            keying on the session id makes the tab follow the order's
            method **structurally** — a remount — rather than by
            convention. The shared primitive is not modified.
          */}
          <Tabs
            key={session.sessionId}
            items={tabs}
            defaultSelectedId={activeTab}
            label="Payment method"
            variant="strip"
          />

          {/* ── The failure ────────────────────────────────────────── */}
          {error ? (
            <div
              role="alert"
              className="mt-4 rounded-[var(--radius-card)] border border-danger/30 bg-danger/10 px-4 py-3"
            >
              <p className="text-xs font-semibold text-danger">{error}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-foreground-muted">
                Your order is still reserved. You can try the payment
                again.
              </p>
            </div>
          ) : null}

          {isPending ? (
            <p
              role="status"
              className="mt-4 flex items-center gap-2 text-xs text-foreground-muted"
            >
              <ShieldIcon width={14} height={14} />
              Contacting the gateway…
            </p>
          ) : null}
        </div>

        {/* ── The footer ─────────────────────────────────────────────── */}
        {/*
          The payment bar.

          It is **outside** the scroll container, so the amount and the
          button are always visible however long the panel content is.
          That is the point of a payment bar: the customer must never
          have to scroll to find the amount they are agreeing to.
        */}
        <div className="shrink-0 border-t border-border bg-surface px-5 py-4">
          {/*
            The amount and the button.

            `flex-wrap` with a `min-w-0` amount block, so on a narrow
            screen the button drops to its own line instead of being
            squeezed into an unreadable sliver. The button is never
            allowed to shrink — `shrink-0` — because a payment button
            that has been squashed to two characters is a button the
            customer cannot read at the moment they most need to.
          */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-foreground-muted">
                Total payable
              </p>

              {/*
                The amount.

                `formatPaisaBare` — the variant that leaves off the `৳`
                symbol — because the button below says "BDT", and
                showing `৳` in both places reads as a mistake. The
                figure itself is the **server's**, never computed here.
              */}
              <p className="text-xl font-bold tabular-nums text-foreground">
                {formatPaisa(session.amountPaisa)}
              </p>
            </div>

            <Button
              type="button"
              variant="primary"
              size="lg"
              disabled={isPending || !detailsAreReady}
              onClick={() => {
                void settle("SUCCESS");
              }}
              className="shrink-0"
            >
              PAY {formatPaisaBare(session.amountPaisa)} BDT
            </Button>
          </div>

          {/*
            The gate's reason.

            A disabled button with no explanation is a dead end — the
            customer cannot tell whether the button is broken or what
            they are missing. So the reason is said out loud, in the
            same place as the button it explains.
          */}
          {!detailsAreReady ? (
            <p
              role="status"
              className="mt-2.5 text-center text-[11px] leading-relaxed text-foreground-muted"
            >
              {isMobileBanking
                ? "Enter your sender number and TrxID to continue."
                : "Enter your card details to continue."}
            </p>
          ) : null}

          {/*
            The failure simulation.

            Deliberately **not** a second button beside PAY, and
            deliberately **not** styled as a destructive action. It is a
            simulation control, not a cancel button — putting it in the
            payment bar as a red button would make it look like one.
            So it sits below the bar, in a low-emphasis ghost link.
          */}
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                void settle("FAILED");
              }}
              className={[
                "text-[11px] text-foreground-muted underline underline-offset-4",
                "transition-colors hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                "disabled:pointer-events-none disabled:opacity-50",
              ].join(" ")}
            >
              Simulate a declined payment
            </button>
          </div>

          <p className="mt-2.5 text-center text-[11px] leading-relaxed text-foreground-muted">
            This is a sandbox window. No real money will be charged, and
            your order is placed either way — the goods are reserved
            while the payment is pending.
          </p>
        </div>
      </div>

      {/*
        The scrim, after the panel.

        See the note above: it must not be the first tab stop.

        `bg-black/60` and `backdrop-blur-sm` — the two together are
        what stop the page bleeding through. The blur alone is too
        soft to separate the panel from a busy checkout page, and the
        black alone leaves the underlying content legible enough to
        compete with the panel's own text.
      */}
      <button
        type="button"
        aria-label="Close the payment window"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
      />
    </div>
  );
}

/**
 * A quick-navigation pill.
 *
 * A `<span>` rather than a `<button>`, because it does **nothing**.
 * It is a label, and rendering it as a button would be a promise the
 * component cannot keep — a button that does nothing when pressed is
 * worse than text.
 */
function QuickNavPill({
  icon,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1",
        "text-xs font-medium text-foreground-muted",
      ].join(" ")}
    >
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}

/**
 * A card-network wordmark pill.
 */
function PaymentNetworkPill({
  label,
  circles = false,
}: {
  readonly label: string;
  readonly circles?: boolean;
}) {
  return (
    <span
      className={[
        "inline-flex h-7 items-center gap-1.5 rounded-md bg-surface px-2.5",
        "text-[10px] font-bold uppercase tracking-wide text-foreground",
        "ring-1 ring-border",
      ].join(" ")}
    >
      {circles ? (
        <span aria-hidden="true" className="relative block h-3 w-5">
          <span className="absolute left-0 top-0 block h-3 w-3 rounded-full bg-red-500/90" />
          <span className="absolute left-2 top-0 block h-3 w-3 rounded-full bg-amber-400/90" />
        </span>
      ) : null}
      {label}
    </span>
  );
}
