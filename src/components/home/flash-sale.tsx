"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ChevronRightIcon } from "@/components/ui/icons";

/**
 * The flash sale banner.
 *
 * ── The countdown ────────────────────────────────────────────────────────
 *
 * The countdown ticks client-side. It is computed against a **fixed
 * target**, not "now + 24 hours" — a countdown that resets every time
 * the page is loaded is a countdown to a lie, and a customer who
 * watches it never reach zero learns to distrust the whole site.
 *
 * The target is the end of the current UTC day, so the banner always
 * shows a live countdown and it expires at a predictable moment.
 *
 * ── Why the clock is read in an effect, not during render ───────────────
 *
 * Next.js's prerenderer treats a `new Date()` read during the render of
 * a client component as an **unstable value**: it cannot be baked into
 * a static page, because it would differ on the next visit. The build
 * fails with *"Next.js encountered the unstable value `new Date()` in a
 * Client Component"*.
 *
 * So the clock is read **after** mount, in an effect, and the server
 * renders a fixed placeholder. That is not a workaround — it is the
 * correct model for a clock: the server does not know what time it is
 * on the customer's device, and pretending otherwise would guarantee a
 * hydration mismatch.
 *
 * The consequence is honest: the first paint shows `--:--:--`, and the
 * real countdown appears a moment later. A placeholder that is
 * obviously a placeholder beats a server-rendered countdown that is
 * wrong by the time it reaches the browser.
 */

/**
 * The number of milliseconds in a day.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The target: the end of the current day, in UTC.
 *
 * Computed once per mount, from the browser's own clock.
 */
function computeTarget(now: number): number {
  const current = new Date(now);

  const endOfDay = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );

  // A clock skew that puts the target in the past must not produce a
  // negative countdown. One day is added as a floor.
  return Math.max(endOfDay, now + DAY_MS);
}

/**
 * The remaining time, broken into its parts.
 */
type Remaining = {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly total: number;
};

/**
 * The placeholder shown before the clock has been read.
 *
 * `null` total means "not known yet", which is different from
 * "expired" — the banner must not claim the sale has ended before it
 * has even started counting.
 */
const UNKNOWN: Remaining = {
  hours: 0,
  minutes: 0,
  seconds: 0,
  total: -1,
};

/**
 * Splits a millisecond duration into hours, minutes and seconds.
 */
function splitRemaining(milliseconds: number): Remaining {
  const clamped = Math.max(0, milliseconds);

  const totalSeconds = Math.floor(clamped / 1000);

  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    total: clamped,
  };
}

/**
 * Pads a number to two digits.
 */
function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * One unit of the countdown.
 */
function TimeUnit({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface/95 font-mono text-base font-bold tabular-nums text-foreground shadow-sm">
        {value}
      </span>
      <span className="mt-1 text-[10px] font-medium uppercase tracking-wider text-white/70">
        {label}
      </span>
    </div>
  );
}

/**
 * The flash sale banner.
 */
export function FlashSale({ href = "/products?isBestSeller=true" }: { href?: string }) {
  const [remaining, setRemaining] = useState<Remaining>(UNKNOWN);

  useEffect(() => {
    // The target is fixed for the life of the component, so a
    // re-render cannot move the deadline and the countdown cannot
    // reset.
    const target = computeTarget(Date.now());

    const tick = () => {
      setRemaining(splitRemaining(target - Date.now()));
    };

    tick();

    const interval = window.setInterval(tick, 1000);

    return () => window.clearInterval(interval);
  }, []);

  const isUnknown = remaining.total < 0;
  const isExpired = !isUnknown && remaining.total <= 0;

  return (
    <section className="relative overflow-hidden rounded-[var(--radius-card)] bg-brand-gradient-deep">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-surface/10 blur-3xl"
      />

      <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-200">
            Flash Sale
          </p>

          <h2 className="mt-1.5 font-serif text-xl font-bold text-white sm:text-2xl">
            {isExpired ? "Today’s deals have ended" : "Today’s deals end at midnight"}
          </h2>

          <p className="mt-1 text-sm text-white/70">
            Up to 20% off best sellers, while stocks last.
          </p>
        </div>

        <div className="flex items-center gap-4">
          {isExpired ? (
            <Link
              href={href}
              className="inline-flex items-center gap-1 rounded-full bg-surface px-5 py-3 text-sm font-semibold text-brand-700 shadow-sm transition-transform duration-200 hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-700"
            >
              Shop the deals
              <ChevronRightIcon width={16} height={16} />
            </Link>
          ) : (
            <>
              <div
                className="flex items-start gap-2"
                role="timer"
                aria-label="Time remaining in the flash sale"
                aria-live="off"
              >
                <TimeUnit
                  value={isUnknown ? "--" : pad(remaining.hours)}
                  label="Hrs"
                />
                <span
                  aria-hidden="true"
                  className="pt-2.5 text-lg font-bold text-white/50"
                >
                  :
                </span>
                <TimeUnit
                  value={isUnknown ? "--" : pad(remaining.minutes)}
                  label="Min"
                />
                <span
                  aria-hidden="true"
                  className="pt-2.5 text-lg font-bold text-white/50"
                >
                  :
                </span>
                <TimeUnit
                  value={isUnknown ? "--" : pad(remaining.seconds)}
                  label="Sec"
                />
              </div>

              <Link
                href={href}
                className="inline-flex items-center gap-1 rounded-full bg-surface px-5 py-3 text-sm font-semibold text-brand-700 shadow-sm transition-transform duration-200 hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-700"
              >
                Shop now
                <ChevronRightIcon width={16} height={16} />
              </Link>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
