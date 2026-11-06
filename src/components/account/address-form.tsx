"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";

/**
 * The saved delivery address.
 *
 * ── What this form is for ─────────────────────────────────────────────────
 *
 * The checkout asks for a delivery address on every order. That is right
 * — an order's address is a **snapshot** of where it was going that day,
 * and it must never be rewritten afterwards. But it means a customer with
 * one home address re-types the same seven fields every time.
 *
 * This form is the answer: the **default** address, pre-filled into the
 * checkout and editable here.
 *
 * ── Why it is one form and not a list of addresses ────────────────────────
 *
 * A customer who moves re-types the address; they do not accumulate a
 * history of them. One saved address per account is what the checkout
 * actually needs, and one is a thing a customer can reason about. A
 * "saved addresses" book would need selection, deletion, a default
 * marker and a tie-breaker rule — all of it machinery for a problem this
 * shop does not have.
 *
 * ── Why saving an address does not move an existing order ────────────────
 *
 * The courier works from the order's own snapshot. Changing the default
 * address changes where the **next** order goes, and nothing else. The
 * form says so, because a customer who expects their parcel to be
 * redirected will be disappointed otherwise.
 */
export type AddressDetails = {
  readonly fullName: string;
  readonly phone: string;
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly district: string;
  readonly postalCode: string;
};

export function AddressForm({
  address,
  customerName,
  customerPhone,
}: {
  /** The saved address, or `null` when there is not one yet. */
  readonly address: AddressDetails | null;
  /** The customer's name, used to pre-fill a brand-new address. */
  readonly customerName: string;
  /** The customer's number, used to pre-fill a brand-new address. */
  readonly customerPhone: string | null;
}) {
  const [fullName, setFullName] = useState(address?.fullName ?? customerName);
  const [phone, setPhone] = useState(address?.phone ?? customerPhone ?? "");
  const [addressLine1, setAddressLine1] = useState(address?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(address?.addressLine2 ?? "");
  const [city, setCity] = useState(address?.city ?? "");
  const [district, setDistrict] = useState(address?.district ?? "");
  const [postalCode, setPostalCode] = useState(address?.postalCode ?? "");

  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const dirty =
    fullName.trim() !== (address?.fullName ?? customerName) ||
    phone.trim() !== (address?.phone ?? customerPhone ?? "") ||
    addressLine1.trim() !== (address?.addressLine1 ?? "") ||
    addressLine2.trim() !== (address?.addressLine2 ?? "") ||
    city.trim() !== (address?.city ?? "") ||
    district.trim() !== (address?.district ?? "") ||
    postalCode.trim() !== (address?.postalCode ?? "");

  async function save() {
    setState("saving");
    setMessage(null);
    setFieldErrors({});

    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: {
            fullName: fullName.trim(),
            phone: phone.trim(),
            addressLine1: addressLine1.trim(),
            ...(addressLine2.trim() === ""
              ? {}
              : { addressLine2: addressLine2.trim() }),
            city: city.trim(),
            district: district.trim(),
            postalCode: postalCode.trim(),
            isDefault: true,
          },
        }),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        error?: {
          message: string;
          details?: { fieldErrors?: Record<string, string[]> };
        };
      };

      if (!payload.ok) {
        setState("error");
        setMessage(payload.error?.message ?? "That could not be saved.");
        setFieldErrors(payload.error?.details?.fieldErrors ?? {});
        return;
      }

      setState("saved");
      setMessage("Your delivery address has been saved.");
    } catch {
      setState("error");
      setMessage("We could not reach the shop. Please try again.");
    }
  }

  return (
    <section aria-labelledby="address-heading" className="space-y-5">
      <div>
        <h2
          id="address-heading"
          className="text-base font-semibold text-foreground"
        >
          Delivery address
        </h2>

        <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
          We will pre-fill this at checkout. It does not change where an
          order you have already placed is going — that address is fixed
          when the order is made.
        </p>
      </div>

      <AddressField
        id="addressFullName"
        label="Full name"
        value={fullName}
        onChange={setFullName}
        error={fieldErrors["address.fullName"]?.[0]}
        autoComplete="name"
      />

      <AddressField
        id="addressPhone"
        label="Mobile number"
        type="tel"
        value={phone}
        onChange={setPhone}
        error={fieldErrors["address.phone"]?.[0]}
        autoComplete="tel"
      />

      <AddressField
        id="addressLine1"
        label="Street address"
        value={addressLine1}
        onChange={setAddressLine1}
        error={fieldErrors["address.addressLine1"]?.[0]}
        autoComplete="address-line1"
      />

      <AddressField
        id="addressLine2"
        label="Apartment, floor, landmark (optional)"
        value={addressLine2}
        onChange={setAddressLine2}
        error={fieldErrors["address.addressLine2"]?.[0]}
        autoComplete="address-line2"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <AddressField
          id="addressCity"
          label="City"
          value={city}
          onChange={setCity}
          error={fieldErrors["address.city"]?.[0]}
          autoComplete="address-level2"
        />

        <AddressField
          id="addressDistrict"
          label="District"
          value={district}
          onChange={setDistrict}
          error={fieldErrors["address.district"]?.[0]}
          autoComplete="address-level1"
        />
      </div>

      <AddressField
        id="addressPostalCode"
        label="Postal code"
        value={postalCode}
        onChange={setPostalCode}
        error={fieldErrors["address.postalCode"]?.[0]}
        autoComplete="postal-code"
        inputMode="numeric"
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void save()}
          disabled={state === "saving" || !dirty}
        >
          {state === "saving" ? "Saving…" : "Save address"}
        </Button>

        {state === "saved" && message ? (
          <p
            role="status"
            className="flex items-center gap-1.5 text-xs font-medium text-green-700"
          >
            <CheckIcon width={14} height={14} />
            {message}
          </p>
        ) : null}

        {state === "error" && message ? (
          <p role="alert" className="text-xs text-red-600">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One labelled field.
 *
 * The error is placed under the input and wired up with
 * `aria-describedby`, so it is announced with the field rather than left
 * in a banner nobody is looking at.
 */
function AddressField({
  id,
  label,
  value,
  onChange,
  type = "text",
  error,
  autoComplete,
  inputMode,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
  readonly error?: string;
  readonly autoComplete?: string;
  readonly inputMode?: "text" | "numeric" | "tel";
}) {
  const errorId = `${id}-error`;

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
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
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
    </div>
  );
}
