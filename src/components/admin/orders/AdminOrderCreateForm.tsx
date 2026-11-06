"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { PlusIcon, TrashIcon } from "@/components/ui/icons";

import { formatPaisa } from "@/lib/format/money";
import { paymentMethodLabel } from "@/lib/format/payment";
import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The admin order creation form.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * The two cases a checkout cannot cover: a **phone order** (a customer
 * rings the shop and asks to pay on delivery, with no cart because they
 * never added anything) and a **replacement order** (a courier returns a
 * damaged parcel and the shop sends a new one).
 *
 * ── The rules that shape it ───────────────────────────────────────────────
 *
 * **1. The form sends product ids and quantities. Never prices.**
 *
 * The prices shown beside each line are the **database's** prices,
 * rendered read-only, so the admin can see what they are about to
 * charge. The form sends no price at all, and the server prices the
 * order from the product rows inside the transaction. An admin's
 * browser is exactly as capable of being tampered with as a customer's,
 * so the same rule applies.
 *
 * **2. The customer must be an existing account.**
 *
 * The order's `userId` is a foreign key. Creating a user as a side
 * effect of creating an order would need a password policy and an
 * email-verification story that does not belong in the fulfilment desk.
 *
 * **3. The reason is mandatory.**
 *
 * An admin-created order is a decision a staff member made on the
 * shop's behalf, and the audit trail has to be able to say which kind
 * of decision it was.
 *
 * **4. A mobile-banking order needs a TrxID.**
 *
 * The server refuses a `BKASH` or `NAGAD` order without one — the shop
 * cannot reconcile a transfer it has no reference for — and it refuses
 * a `COD` or `CARD` order **with** one, because a recorded transfer
 * that does not exist is worse than a missing one.
 */

/**
 * A customer the order can be for.
 */
export type AdminOrderCustomer = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
};

/**
 * A product the order can contain.
 */
export type AdminOrderProduct = {
  readonly id: string;
  readonly name: string;
  readonly pricePaisa: number;
  readonly discountPricePaisa: number | null;
  readonly stockQuantity: number;
};

/**
 * The props for the form.
 */
export type AdminOrderCreateFormProps = {
  readonly customers: readonly AdminOrderCustomer[];
  readonly products: readonly AdminOrderProduct[];
};

/**
 * One line of the order being built.
 */
type DraftLine = {
  readonly productId: string;
  readonly quantity: number;
};

/**
 * The payment methods, in the order they are offered.
 */
const PAYMENT_METHODS = ["COD", "BKASH", "NAGAD", "CARD"] as const;

/**
 * The admin order creation form.
 */
export function AdminOrderCreateForm({
  customers,
  products,
}: AdminOrderCreateFormProps) {
  const router = useRouter();

  const [userId, setUserId] = useState(customers[0]?.id ?? "");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<string>("COD");
  const [paymentTransactionId, setPaymentTransactionId] = useState("");
  const [paymentSenderNumber, setPaymentSenderNumber] = useState("");
  const [reason, setReason] = useState("");

  const [lines, setLines] = useState<DraftLine[]>(() =>
    products[0] ? [{ productId: products[0].id, quantity: 1 }] : [],
  );

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The estimated total.
   *
   * An **estimate**, computed from the prices the server sent with the
   * product list. It is shown so the admin can see what they are about
   * to charge — the authoritative figure is the one the server
   * computes, and it is what the order records.
   */
  const estimate = useMemo(() => {
    let subtotal = 0;
    let quantity = 0;

    for (const line of lines) {
      const product = products.find(
        (candidate) => candidate.id === line.productId,
      );

      if (!product) continue;

      const unit = product.discountPricePaisa ?? product.pricePaisa;

      subtotal += unit * line.quantity;
      quantity += line.quantity;
    }

    return { subtotal, quantity };
  }, [lines, products]);

  const isMobileBanking =
    paymentMethod === "BKASH" || paymentMethod === "NAGAD";

  /**
   * Picks the customer, and copies their details into the form.
   *
   * The address fields start empty rather than being guessed — the shop
   * should confirm the delivery address on a phone order, because a
   * stale address in an account is a parcel delivered to the wrong
   * house.
   */
  function chooseCustomer(nextUserId: string): void {
    setUserId(nextUserId);

    const customer = customers.find((candidate) => candidate.id === nextUserId);

    if (!customer) return;

    setFullName(customer.name);

    if (customer.phone) {
      setPhone(customer.phone);
    }
  }

  function updateLine(index: number, changes: Partial<DraftLine>): void {
    setLines((current) =>
      current.map((line, position) =>
        position === index ? { ...line, ...changes } : line,
      ),
    );
  }

  function removeLine(index: number): void {
    setLines((current) => current.filter((_, position) => position !== index));
  }

  function addLine(): void {
    const first = products[0];

    if (!first) return;

    setLines((current) => [...current, { productId: first.id, quantity: 1 }]);
  }

  async function submit(): Promise<void> {
    setIsPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/orders", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId,
          fullName: fullName.trim(),
          phone: phone.trim(),
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim(),
          district: district.trim(),
          postalCode: postalCode.trim(),
          notes: notes.trim() || undefined,
          paymentMethod,
          paymentTransactionId: isMobileBanking
            ? paymentTransactionId.trim()
            : undefined,
          paymentSenderNumber: isMobileBanking
            ? paymentSenderNumber.trim() || undefined
            : undefined,
          lines: lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
          })),
          reason: reason.trim(),
        }),
      });

      const payload = (await response.json()) as ApiEnvelope<{
        order: { orderId: string; orderNumber: string };
      }>;

      if (!payload.ok) {
        throw new Error(payload.error.message);
      }

      router.push(`/admin/orders/${payload.data.order.orderId}`);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not reach the server. Nothing was changed.",
      );
      setIsPending(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="grid gap-4 lg:grid-cols-3"
    >
      {/*
        The left column — the customer and the delivery.
      */}
      <div className="space-y-4 lg:col-span-2">
        <Panel title="Customer">
          <Field label="Account" htmlFor="order-user">
            <select
              id="order-user"
              value={userId}
              onChange={(event) => {
                chooseCustomer(event.target.value);
              }}
              required
              className="h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            >
              <option value="">Choose a customer…</option>

              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name} — {customer.email}
                </option>
              ))}
            </select>
          </Field>

          <p className="mt-2 text-xs text-foreground-muted">
            The order is attached to this customer, so they can see it in
            their own order history. Only existing accounts can be used.
          </p>
        </Panel>

        <Panel title="Delivery">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Recipient name" htmlFor="order-name">
              <input
                id="order-name"
                type="text"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                required
                maxLength={160}
                className={inputClass}
              />
            </Field>

            <Field label="Phone" htmlFor="order-phone">
              <input
                id="order-phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                required
                maxLength={20}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Address line 1" htmlFor="order-address-1">
            <input
              id="order-address-1"
              type="text"
              value={addressLine1}
              onChange={(event) => setAddressLine1(event.target.value)}
              required
              maxLength={200}
              className={inputClass}
            />
          </Field>

          <Field label="Address line 2 (optional)" htmlFor="order-address-2">
            <input
              id="order-address-2"
              type="text"
              value={addressLine2}
              onChange={(event) => setAddressLine2(event.target.value)}
              maxLength={200}
              className={inputClass}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="City" htmlFor="order-city">
              <input
                id="order-city"
                type="text"
                value={city}
                onChange={(event) => setCity(event.target.value)}
                required
                maxLength={120}
                className={inputClass}
              />
            </Field>

            <Field label="District" htmlFor="order-district">
              <input
                id="order-district"
                type="text"
                value={district}
                onChange={(event) => setDistrict(event.target.value)}
                required
                maxLength={120}
                className={inputClass}
              />
            </Field>

            <Field label="Postal code" htmlFor="order-postal">
              <input
                id="order-postal"
                type="text"
                value={postalCode}
                onChange={(event) => setPostalCode(event.target.value)}
                required
                maxLength={10}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Delivery notes (optional)" htmlFor="order-notes">
            <textarea
              id="order-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              maxLength={500}
              className="w-full rounded-2xl border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </Field>
        </Panel>

        <Panel title="Payment">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {PAYMENT_METHODS.map((method) => (
              <label
                key={method}
                className={[
                  "cursor-pointer rounded-2xl border px-3.5 py-3 transition-colors",
                  paymentMethod === method
                    ? "border-brand-300 bg-brand-50"
                    : "border-border bg-surface hover:border-brand-200 hover:bg-brand-50/40",
                ].join(" ")}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="payment-method"
                    value={method}
                    checked={paymentMethod === method}
                    onChange={() => setPaymentMethod(method)}
                    className="h-4 w-4 accent-[var(--brand-600)]"
                  />

                  <span className="text-sm font-medium text-foreground">
                    {paymentMethodLabel(method)}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {isMobileBanking ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="TrxID" htmlFor="order-trxid">
                <input
                  id="order-trxid"
                  type="text"
                  value={paymentTransactionId}
                  onChange={(event) => setPaymentTransactionId(event.target.value)}
                  required
                  maxLength={64}
                  className={inputClass}
                />
              </Field>

              <Field label="Sent from" htmlFor="order-sender">
                <input
                  id="order-sender"
                  type="tel"
                  value={paymentSenderNumber}
                  onChange={(event) => setPaymentSenderNumber(event.target.value)}
                  maxLength={20}
                  className={inputClass}
                />
              </Field>
            </div>
          ) : null}
        </Panel>
      </div>

      {/*
        The right column — the items and the reason.
      */}
      <div className="space-y-4">
        <Panel
          title="Items"
          action={
            <button
              type="button"
              onClick={addLine}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-surface px-3 text-xs font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              <PlusIcon width={13} height={13} />
              Add
            </button>
          }
        >
          {lines.length === 0 ? (
            <p className="text-xs text-foreground-muted">
              No items yet. Add at least one.
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map((line, index) => {
                const product = products.find(
                  (candidate) => candidate.id === line.productId,
                );

                const unit = product
                  ? (product.discountPricePaisa ?? product.pricePaisa)
                  : 0;

                return (
                  <li key={index} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Product for line ${index + 1}`}
                        value={line.productId}
                        onChange={(event) => {
                          updateLine(index, { productId: event.target.value });
                        }}
                        className="h-9 min-w-0 flex-1 rounded-full border border-border bg-surface px-3 text-xs text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
                      >
                        {products.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        onClick={() => {
                          removeLine(index);
                        }}
                        aria-label={`Remove line ${index + 1}`}
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                      >
                        <TrashIcon width={15} height={15} />
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="sr-only" htmlFor={`order-qty-${index}`}>
                        Quantity for line {index + 1}
                      </label>

                      <input
                        id={`order-qty-${index}`}
                        type="number"
                        min={1}
                        max={100}
                        value={line.quantity}
                        onChange={(event) => {
                          updateLine(index, {
                            quantity: Math.max(
                              1,
                              Math.min(
                                100,
                                Number.parseInt(event.target.value, 10) || 1,
                              ),
                            ),
                          });
                        }}
                        className="h-8 w-16 rounded-full border border-border bg-surface px-2.5 text-xs tabular-nums text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
                      />

                      <span className="text-xs tabular-nums text-foreground-muted">
                        {formatPaisa(unit * line.quantity)}
                      </span>

                      {product && product.stockQuantity < line.quantity ? (
                        <span className="text-[11px] text-red-700">
                          only {product.stockQuantity} left
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/*
            The estimate.

            Labelled as an estimate, because the authoritative figure is
            the one the server computes when it prices the order.
          */}
          <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
            <span className="text-xs text-foreground-muted">
              Estimated total ({estimate.quantity} item
              {estimate.quantity === 1 ? "" : "s"})
            </span>

            <span className="text-sm font-bold tabular-nums text-foreground">
              {formatPaisa(estimate.subtotal)}
            </span>
          </div>
        </Panel>

        <Panel title="Reason">
          <Field label="Why is this order being created?" htmlFor="order-reason">
            <textarea
              id="order-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              rows={3}
              maxLength={500}
              placeholder="Phone order — customer called to place it directly."
              className="w-full rounded-2xl border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </Field>

          <p className="mt-2 text-xs text-foreground-muted">
            Recorded in the audit log against your name.
          </p>
        </Panel>

        {error ? (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-xs text-red-800">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-neutral-900 px-5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
        >
          {isPending ? "Creating the order…" : "Create the order"}
        </button>
      </div>
    </form>
  );
}

/**
 * The shared input class.
 */
const inputClass =
  "h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200";

/**
 * A panel — one section of the form.
 */
function Panel({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-foreground">{title}</h2>

        {action ? <div className="shrink-0">{action}</div> : null}
      </div>

      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * A labelled field.
 */
function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-foreground-muted"
      >
        {label}
      </label>

      {children}
    </div>
  );
}
