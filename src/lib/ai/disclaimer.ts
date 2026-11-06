/**
 * The disclaimer.
 *
 * ── Why it is a module of its own ────────────────────────────────────────
 *
 * The disclaimer is a **product requirement**, not a nicety. PRD §3.A
 * requires it to be visible during the chat session, and the feature
 * spec (§5.4) requires it to be enforced in **three** places, because a
 * UI-only guarantee fails the moment somebody calls the API directly.
 *
 * This module holds the two things that must never change:
 *
 *   1. The hardcoded fallback text. There is always a disclaimer. If
 *      the `AiConfig` row is missing, the service still attaches one.
 *      A missing configuration must never mean "no disclaimer".
 *   2. The version stamp. Every assistant message records the version
 *      of the disclaimer the user was actually shown, so a later
 *      dispute can be answered factually.
 */

import { db } from "@/lib/db";

/**
 * The hardcoded fallback disclaimer.
 *
 * This exact string is also the default in `.env.example` and the
 * fallback in `src/lib/ai/provider.ts`. It is duplicated deliberately:
 * the fallback must not depend on a database read, an environment
 * variable, or a network call. If the database is down, the disclaimer
 * still ships.
 */
export const FALLBACK_DISCLAIMER_TEXT =
  "This is an aesthetic/skincare suggestion, not a medical prescription from a doctor.";

/**
 * The version stamped when the fallback text is used.
 *
 * `0` means "the hardcoded fallback, not the admin-managed text". It is
 * deliberately distinct from the `AiConfig` version numbering, which
 * starts at `1`, so an audit can tell the two apart.
 */
export const FALLBACK_DISCLAIMER_VERSION = 0;

/**
 * The resolved disclaimer.
 */
export type Disclaimer = {
  readonly text: string;
  readonly version: number;
};

/**
 * The disclaimer shown when nothing else is available.
 */
export const FALLBACK_DISCLAIMER: Disclaimer = {
  text: FALLBACK_DISCLAIMER_TEXT,
  version: FALLBACK_DISCLAIMER_VERSION,
};

/**
 * Loads the admin-managed disclaimer.
 *
 * A missing row, an empty row, or a database failure all fall back to
 * the hardcoded constant. There is no code path that returns "no
 * disclaimer" — that is the whole point of this function.
 */
export async function loadDisclaimer(): Promise<Disclaimer> {
  try {
    const config = await db.aiConfig.findUnique({
      where: { key: "default" },
      select: { disclaimerText: true, disclaimerVersion: true },
    });

    if (!config) {
      return FALLBACK_DISCLAIMER;
    }

    const text = config.disclaimerText.trim();

    // An empty disclaimer is a configuration error, not a request to
    // show nothing. The fallback is safer than an empty banner.
    if (text.length === 0) {
      return FALLBACK_DISCLAIMER;
    }

    return {
      text,
      version: config.disclaimerVersion,
    };
  } catch (error) {
    console.error("[advisor] Disclaimer load failed:", error);

    return FALLBACK_DISCLAIMER;
  }
}
