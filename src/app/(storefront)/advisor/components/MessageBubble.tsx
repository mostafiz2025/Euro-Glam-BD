import Image from "next/image";

import { SparkleIcon, WarningIcon } from "@/components/ui/icons";

import { ProductRecommendationCard } from "./ProductRecommendationCard";

import type {
  AdvisorConflict,
  AdvisorRecommendation,
} from "@/lib/format/types";

/**
 * One message in the advisor transcript.
 *
 * ── The rules that govern this file ──────────────────────────────────────
 *
 * **1. Conflicts are rendered from the code-decided list.**
 *
 * The `conflicts` prop is the engine's output, re-attached by the service
 * layer *after* the model returned. Whatever the model said about a
 * conflict was discarded. So this component shows a `BLOCK` as a `BLOCK`
 * and a `WARN` as a `WARN`, with no possibility of a downgrade.
 *
 * **2. The severity is visible, and it is styled by severity.**
 *
 * A `BLOCK` is red — the two products must not be used together. A `WARN`
 * is amber — they can be used, spaced apart. Rendering both in the same
 * neutral grey would flatten the one distinction that matters.
 *
 * **3. The advice is complete.**
 *
 * A conflict shows the remedy *and* the spacing advice. "These conflict"
 * with no next step is a dead end; the customer cannot act on it.
 */
export type MessageBubbleProps = {
  readonly role: "USER" | "ASSISTANT";
  readonly content: string;
  readonly createdAt: string;
  readonly isMocked?: boolean;
  readonly recommendations?: readonly AdvisorRecommendation[];
  readonly conflicts?: readonly AdvisorConflict[];
  readonly images?: ReadonlyArray<{
    readonly id: string;
    readonly url: string;
    readonly mimeType: string;
  }>;
};

/**
 * The conflict notice.
 */
function ConflictNotice({ conflict }: { readonly conflict: AdvisorConflict }) {
  const isBlock = conflict.severity === "BLOCK";

  return (
    <div
      role="alert"
      className={[
        "rounded-xl border px-3 py-2.5",
        isBlock
          ? "border-red-200 bg-red-50"
          : "border-amber-200 bg-amber-50",
      ].join(" ")}
    >
      <p
        className={[
          "flex items-start gap-2 text-xs font-semibold",
          isBlock ? "text-red-800" : "text-amber-800",
        ].join(" ")}
      >
        <span className="mt-0.5 shrink-0">
          <WarningIcon width={15} height={15} />
        </span>

        <span>
          {isBlock ? "Do not combine" : "Use with care"}
          <span className="font-normal"> — {conflict.title}</span>
        </span>
      </p>

      <p
        className={[
          "mt-1.5 text-xs leading-relaxed",
          isBlock ? "text-red-700" : "text-amber-700",
        ].join(" ")}
      >
        {conflict.message}
      </p>

      <p
        className={[
          "mt-1.5 text-xs leading-relaxed",
          isBlock ? "text-red-700" : "text-amber-700",
        ].join(" ")}
      >
        <span className="font-medium">What to do: </span>
        {conflict.remedy}
      </p>

      {conflict.spacingAdvice.length > 0 ? (
        <p
          className={[
            "mt-1 text-xs leading-relaxed",
            isBlock ? "text-red-600" : "text-amber-600",
          ].join(" ")}
        >
          {conflict.spacingAdvice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The message bubble.
 */
export function MessageBubble({
  role,
  content,
  createdAt,
  isMocked = false,
  recommendations = [],
  conflicts = [],
  images = [],
}: MessageBubbleProps) {
  const isUser = role === "USER";

  return (
    <div
      className={[
        "flex w-full gap-2.5",
        isUser ? "justify-end" : "justify-start",
      ].join(" ")}
    >
      {!isUser ? (
        <span
          aria-hidden="true"
          className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700"
        >
          <SparkleIcon width={16} height={16} />
        </span>
      ) : null}

      <div
        className={[
          "min-w-0 max-w-[85%] space-y-2.5",
          isUser ? "items-end" : "items-start",
        ].join(" ")}
      >
        <div
          className={[
            "rounded-2xl px-4 py-2.5",
            isUser
              ? "rounded-br-sm bg-brand-600 text-white"
              : "rounded-bl-sm bg-surface-muted text-foreground",
          ].join(" ")}
        >
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {content}
          </p>
        </div>

        {images.map((image) => (
          <Image
            key={image.id}
            src={image.url}
            alt="Attached by you"
            width={280}
            height={280}
            sizes="(min-width: 1024px) 280px, 60vw"
            className="max-h-56 w-auto rounded-xl border border-border object-cover"
          />
        ))}

        {conflicts.length > 0 ? (
          <div className="space-y-2">
            {conflicts.map((conflict) => (
              <ConflictNotice
                key={`${conflict.ruleId}-${conflict.involvedProductIds.join("-")}`}
                conflict={conflict}
              />
            ))}
          </div>
        ) : null}

        {recommendations.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
              Recommended for you
            </p>

            {recommendations.map((recommendation) => (
              <ProductRecommendationCard
                key={recommendation.productId}
                recommendation={recommendation}
              />
            ))}
          </div>
        ) : null}

        <p
          className={[
            "px-1 text-[11px] text-foreground-muted",
            isUser ? "text-right" : "text-left",
          ].join(" ")}
        >
          {new Date(createdAt).toLocaleTimeString("en-BD", {
            hour: "numeric",
            minute: "2-digit",
          })}
          {!isUser && isMocked ? " · demo answer" : null}
        </p>
      </div>
    </div>
  );
}
