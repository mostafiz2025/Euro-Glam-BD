import { StarIcon } from "./icons";

/**
 * The star rating.
 *
 * ── How the stars are drawn ─────────────────────────────────────────────
 *
 * The stars are drawn with a **clip overlay** rather than by colouring
 * individual stars. A half-star — the honest representation of a 4.3
 * average — is genuinely hard to draw with five discrete star glyphs,
 * and a shop that rounds 4.3 down to four filled stars is lying by a
 * whole star.
 *
 * So: a row of empty stars, and a row of filled stars clipped to
 * `average / 5` of the width. The clip is a percentage, so 4.3 renders
 * as 86% of the stars filled — exactly, with no rounding.
 */

/**
 * The props for the rating display.
 */
export type RatingProps = {
  /** The average rating, from 0 to 5. */
  readonly average: number;
  /** How many ratings there are. */
  readonly count?: number;
  /** The size of the stars. */
  readonly size?: "sm" | "md";
  /** Whether to show the numeric average and the count. */
  readonly showNumbers?: boolean;
  readonly className?: string;
};

/**
 * The pixel size for each star size.
 */
const STAR_SIZE: Record<"sm" | "md", number> = { sm: 14, md: 18 };

export function Rating({
  average,
  count,
  size = "sm",
  showNumbers = false,
  className,
}: RatingProps) {
  const starSize = STAR_SIZE[size];
  const clamped = Math.max(0, Math.min(5, average));
  const fillPercent = (clamped / 5) * 100;

  const stars = (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: starSize * 5, height: starSize }}
      aria-hidden="true"
    >
      {/* The empty layer. */}
      <span className="absolute inset-0 flex">
        {Array.from({ length: 5 }, (_, index) => (
          <StarIcon
            key={index}
            width={starSize}
            height={starSize}
            className="text-neutral-300"
            strokeWidth={1.5}
          />
        ))}
      </span>

      {/* The filled layer, clipped to the exact fraction. */}
      <span
        className="absolute inset-0 flex overflow-hidden"
        style={{ width: `${fillPercent}%` }}
      >
        {Array.from({ length: 5 }, (_, index) => (
          <StarIcon
            key={index}
            width={starSize}
            height={starSize}
            className="shrink-0 text-brand-500"
            fill="currentColor"
            strokeWidth={1.5}
          />
        ))}
      </span>
    </span>
  );

  const accessibleLabel =
    count === undefined
      ? `Rated ${clamped} out of 5`
      : `Rated ${clamped} out of 5 from ${count} reviews`;

  return (
    <span className={["inline-flex items-center gap-1.5", className ?? ""].filter(Boolean).join(" ")}>
      <span role="img" aria-label={accessibleLabel}>
        {stars}
      </span>

      {showNumbers ? (
        <span className="text-xs text-foreground-muted">
          <span className="font-semibold text-foreground">
            {clamped.toFixed(1)}
          </span>
          {count !== undefined ? (
            <span className="ml-1 text-foreground-muted">({count})</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
