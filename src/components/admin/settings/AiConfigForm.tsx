"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { AdminAiConfig } from "@/lib/admin/ai-config";

/**
 * The AI-configuration form.
 *
 * ── Why the form sends only what changed ─────────────────────────────────
 *
 * This is a **partial** update. The disclaimer is compliance text, and a
 * form that PUT the whole configuration on every save would overwrite
 * the disclaimer with a stale copy whenever the admin edited the
 * product allow-list. So the client tracks which fields it touched and
 * sends only those.
 *
 * The dirty-tracking is per-field rather than per-form for the same
 * reason: "I changed the prompt but not the disclaimer" is a real state,
 * and it must not send the disclaimer.
 *
 * ── The version is not editable ───────────────────────────────────────────
 *
 * `disclaimerVersion` is a stamp the service increments when the text
 * changes. It is shown here for information and is never sent back —
 * a client that could set it could make two different disclaimers share
 * a version number, which would destroy the audit trail the stamp
 * exists to provide.
 */
export function AiConfigForm({ config }: { readonly config: AdminAiConfig | null }) {
  const router = useRouter();

  const [disclaimerText, setDisclaimerText] = useState(
    config?.disclaimerText ?? "",
  );
  const [systemPrompt, setSystemPrompt] = useState(
    config?.systemPrompt ?? "",
  );
  const [enforceCartConflicts, setEnforceCartConflicts] = useState(
    config?.enforceCartConflicts ?? true,
  );
  const [aiProductIds, setAiProductIds] = useState(
    (config?.aiProductIds ?? []).join(", "),
  );

  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    readonly tone: "good" | "bad";
    readonly text: string;
  } | null>(null);

  const markDirty = (field: string): void => {
    setDirty((previous) => ({ ...previous, [field]: true }));
    setMessage(null);
  };

  const hasChanges = Object.values(dirty).some(Boolean);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!hasChanges) return;

    // Only the touched fields go on the wire. An untouched field is
    // absent, not "unchanged" — the server distinguishes the two.
    const body: Record<string, unknown> = {};

    if (dirty.disclaimerText) {
      body.disclaimerText = disclaimerText.trim();
    }

    if (dirty.systemPrompt) {
      // An empty prompt clears the override — that is a real setting,
      // and the service stores it as null.
      body.systemPrompt = systemPrompt.trim() === "" ? null : systemPrompt;
    }

    if (dirty.enforceCartConflicts) {
      body.enforceCartConflicts = enforceCartConflicts;
    }

    if (dirty.aiProductIds) {
      body.aiProductIds = aiProductIds
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    }

    setPending(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/settings/ai-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        data?: unknown;
        error?: { message?: string };
      };

      if (!response.ok || !payload.ok) {
        setMessage({
          tone: "bad",
          // The server's message is the useful part — it names the
          // actual problem. A generic "Something went wrong" would
          // hide it.
          text:
            payload.error?.message ??
            "The configuration could not be saved. Please try again.",
        });
        return;
      }

      setDirty({});
      setMessage({
        tone: "good",
        text: "The configuration has been saved and recorded in the audit log.",
      });

      // Re-render the server components so the version stamp and any
      // other server-rendered part of the page reflect the new value.
      router.refresh();
    } catch {
      setMessage({
        tone: "bad",
        text: "The configuration could not be saved. Please check your connection and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* ── The disclaimer ──────────────────────────────────────────── */}
      <Field
        label="Disclaimer text"
        description="Shown to every customer during an advisor conversation. This is compliance text and cannot be empty."
        htmlFor="disclaimerText"
      >
        <textarea
          id="disclaimerText"
          value={disclaimerText}
          onChange={(event) => {
            setDisclaimerText(event.target.value);
            markDirty("disclaimerText");
          }}
          rows={4}
          maxLength={2000}
          required
          className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />
      </Field>

      <p className="-mt-3 text-xs text-foreground-muted">
        Version{" "}
        <span className="font-semibold tabular-nums text-foreground">
          {config?.disclaimerVersion ?? 0}
        </span>
        {" · "}
        This stamp is incremented by the server whenever the text changes.
        It is never set by hand, because a version that a client could
        set could not identify which disclaimer a customer actually saw.
      </p>

      {/* ── The system prompt ───────────────────────────────────────── */}
      <Field
        label="System prompt override"
        description="Replaces the advisor's default instructions. Leave empty to use the built-in prompt."
        htmlFor="systemPrompt"
      >
        <textarea
          id="systemPrompt"
          value={systemPrompt}
          onChange={(event) => {
            setSystemPrompt(event.target.value);
            markDirty("systemPrompt");
          }}
          rows={5}
          maxLength={4000}
          className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />
      </Field>

      {/* ── The allow-list ──────────────────────────────────────────── */}
      <Field
        label="Recommended product ids"
        description="Comma-separated product ids the advisor may recommend. Leave empty to allow every product."
        htmlFor="aiProductIds"
      >
        <input
          id="aiProductIds"
          value={aiProductIds}
          onChange={(event) => {
            setAiProductIds(event.target.value);
            markDirty("aiProductIds");
          }}
          maxLength={8000}
          className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />
      </Field>

      {/* ── The cart-conflict switch ───────────────────────────────── */}
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-border bg-surface-muted px-4 py-3">
        <input
          id="enforceCartConflicts"
          type="checkbox"
          checked={enforceCartConflicts}
          onChange={(event) => {
            setEnforceCartConflicts(event.target.checked);
            markDirty("enforceCartConflicts");
          }}
          className="mt-0.5 h-4 w-4 rounded border-border text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />

        <label htmlFor="enforceCartConflicts">
          <span className="block text-sm font-medium text-foreground">
            Enforce cart conflicts
          </span>

          <span className="mt-0.5 block text-xs text-foreground-muted">
            When on, the advisor must not recommend a product that
            conflicts with something already in the customer&apos;s cart.
          </span>
        </label>
      </div>

      {/* ── The feedback and the submit ─────────────────────────────── */}
      {message ? (
        <p
          role="status"
          className={[
            "rounded-[var(--radius-card)] border px-4 py-3 text-sm",
            message.tone === "good"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
          ].join(" ")}
        >
          {message.text}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!hasChanges || pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>

        {!hasChanges ? (
          <span className="text-xs text-foreground-muted">
            Nothing has changed yet.
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * A labelled form field.
 */
function Field({
  label,
  description,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly description: string;
  readonly htmlFor: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-foreground"
      >
        {label}
      </label>

      <p className="mt-0.5 text-xs text-foreground-muted">{description}</p>

      <div className="mt-2">{children}</div>
    </div>
  );
}
