"use client";

import { useState } from "react";

import { PaymentGatewayModal } from "@/components/commerce/payment-gateway-modal";
import { Button } from "@/components/ui/button";
import type { ApiEnvelope } from "@/lib/format/types";
import type { GatewaySessionPayload } from "@/lib/payments/session";

/**
 * "Pay now" — the way back into the gateway.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The checkout opens the gateway window with the session that was minted
 * **inside the order transaction**. That covers the normal path.
 *
 * It does not cover the customer who closed the tab mid-payment, or the
 * one whose payment attempt failed and who wants to try again later.
 * They have an order, the stock is reserved, the payment is `PENDING`,
 * and the token they were holding is still on the order — but no way
 * back to the window.
 *
 * This button is that way back. It asks the server for a fresh session
 * and opens the window.
 *
 * ── The server owns the session ──────────────────────────────────────────
 *
 * The button sends **no token** and **no amount**. It sends the order id
 * and nothing else, and the server reads the order, mints a fresh
 * session, and returns the payload. A client that could choose its own
 * token, or its own amount, would be a client that could edit the
 * payment.
 */
export function PayNowButton({ orderId }: { readonly orderId: string }) {
  const [session, setSession] = useState<GatewaySessionPayload | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openWindow(): Promise<void> {
    if (isPending) return;

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/orders/${orderId}/payment/session`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });

      const payload = (await response.json()) as ApiEnvelope<{
        session: GatewaySessionPayload;
      }>;

      if (!payload.ok) {
        setError(payload.error.message);
        setIsPending(false);
        return;
      }

      setSession(payload.data.session);
      setIsPending(false);
    } catch {
      setError(
        "We could not reach the payment gateway. Please try again in a moment.",
      );
      setIsPending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={isPending}
        onClick={() => {
          void openWindow();
        }}
      >
        {isPending ? "Opening…" : "Pay now"}
      </Button>

      {error ? (
        <p role="alert" className="mt-2 w-full text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {session ? (
        <PaymentGatewayModal
          session={session}
          onPaid={() => {
            setSession(null);
            // The order page now reads PAID, so it has to be re-rendered.
            window.location.reload();
          }}
          onClose={() => {
            setSession(null);
          }}
        />
      ) : null}
    </>
  );
}
