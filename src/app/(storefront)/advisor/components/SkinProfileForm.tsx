"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";

import type { AdvisorProfile } from "@/lib/format/types";

/**
 * The skin profile form.
 *
 * ── The rules that govern this file ──────────────────────────────────────
 *
 * **1. The skin type is never inferred, and never changed by the
 * advisor.**
 *
 * The customer picks it here, deliberately. A phrase in a chat message
 * is weaker evidence than a field the customer set on purpose, so the
 * advisor only ever *adds* concerns (in the chat route) and never
 * touches the skin type.
 *
 * **2. The concern list is a closed catalogue.**
 *
 * Every chip is one of the twelve known concerns. A customer cannot type
 * a new one, which means the list stays joinable against the conflict
 * engine's ingredient tags and the catalogue's filters.
 *
 * **3. The form replaces the list, it does not merge it.**
 *
 * Unchecking a chip removes it. The advisory wording in the API docs
 * explains why: a merge would make unchecking a box impossible, and a
 * customer who removes a concern means it.
 */
export type SkinProfileFormProps = {
  readonly profile: AdvisorProfile;
  /** The concern catalogue, passed down from the server. */
  readonly concerns: readonly { readonly id: string; readonly label: string }[];
  readonly skinTypes: readonly { readonly id: string; readonly label: string }[];
};

export function SkinProfileForm({
  profile,
  concerns,
  skinTypes,
}: SkinProfileFormProps) {
  const [skinType, setSkinType] = useState<string>(profile.skinType ?? "");
  const [selected, setSelected] = useState<readonly string[]>(
    profile.concerns,
  );
  const [notes, setNotes] = useState(profile.notes ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );

    setState("idle");
  }

  async function save() {
    setState("saving");
    setError(null);

    try {
      const response = await fetch("/api/advisor/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skinType: skinType === "" ? null : skinType,
          concerns: selected,
          notes: notes.trim().length === 0 ? null : notes.trim(),
        }),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message: string };
      };

      if (!payload.ok) {
        setState("error");
        setError(payload.error?.message ?? "That could not be saved.");
        return;
      }

      setState("saved");
    } catch {
      setState("error");
      setError("We could not reach the shop. Please try again.");
    }
  }

  return (
    <section aria-labelledby="profile-heading" className="space-y-5">
      <div>
        <h2
          id="profile-heading"
          className="text-base font-semibold text-foreground"
        >
          Your skin profile
        </h2>

        <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
          The more we know, the better we can match. This makes your
          suggestions sharper — it is never shared.
        </p>
      </div>

      {/* ── The skin type ─────────────────────────────────────────────── */}
      <fieldset>
        <legend className="text-sm font-medium text-foreground">
          Skin type
        </legend>

        <div className="mt-2.5 flex flex-wrap gap-2">
          {skinTypes.map((type) => {
            const isSelected = skinType === type.id;

            return (
              <button
                key={type.id}
                type="button"
                onClick={() => {
                  setSkinType(isSelected ? "" : type.id);
                  setState("idle");
                }}
                aria-pressed={isSelected}
                className={[
                  "rounded-full border px-3.5 py-1.5 text-xs font-medium",
                  "transition-colors duration-200",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                  isSelected
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-border bg-surface text-foreground-muted hover:border-brand-300 hover:text-brand-700",
                ].join(" ")}
              >
                {type.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* ── The concerns ──────────────────────────────────────────────── */}
      <fieldset>
        <legend className="text-sm font-medium text-foreground">
          Concerns
        </legend>

        <p className="mt-1 text-xs text-foreground-muted">
          Pick everything that applies.
        </p>

        <div className="mt-2.5 flex flex-wrap gap-2">
          {concerns.map((concern) => {
            const isSelected = selected.includes(concern.id);

            return (
              <button
                key={concern.id}
                type="button"
                onClick={() => toggle(concern.id)}
                aria-pressed={isSelected}
                className={[
                  "rounded-full border px-3.5 py-1.5 text-xs font-medium",
                  "transition-colors duration-200",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                  isSelected
                    ? "border-brand-600 bg-brand-100 text-brand-800"
                    : "border-border bg-surface text-foreground-muted hover:border-brand-300 hover:text-brand-700",
                ].join(" ")}
              >
                {concern.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* ── The notes ─────────────────────────────────────────────────── */}
      <div>
        <label
          htmlFor="profile-notes"
          className="text-sm font-medium text-foreground"
        >
          Anything else we should know?
        </label>

        <textarea
          id="profile-notes"
          value={notes}
          onChange={(event) => {
            setNotes(event.target.value);
            setState("idle");
          }}
          rows={3}
          maxLength={4000}
          placeholder="Allergies, a routine you already follow, what you have tried…"
          className="mt-2 w-full resize-y rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
      </div>

      {/* ── The save ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={state === "saving"}>
          {state === "saving" ? "Saving…" : "Save profile"}
        </Button>

        {state === "saved" ? (
          <p
            role="status"
            className="flex items-center gap-1.5 text-xs font-medium text-green-700"
          >
            <CheckIcon width={14} height={14} />
            Saved
          </p>
        ) : null}

        {state === "error" && error ? (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
