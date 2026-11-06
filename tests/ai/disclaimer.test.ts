import { describe, expect, it } from "vitest";

import {
  FALLBACK_DISCLAIMER,
  FALLBACK_DISCLAIMER_TEXT,
  FALLBACK_DISCLAIMER_VERSION,
} from "@/lib/ai/disclaimer";

/**
 * The disclaimer's fallback.
 *
 * ── What is being protected ─────────────────────────────────────────────
 *
 * The disclaimer is a **product requirement** (PRD §3.A) and the feature
 * spec makes it non-disableable (§5.4). The service layer always
 * attaches one — the admin-managed text when the `AiConfig` row exists
 * and is non-empty, the hardcoded constant otherwise.
 *
 * These tests pin the *constant*, not the database read. The database
 * read needs a database; the constant is the thing that must never
 * change without a deliberate edit, because it is the last line of
 * defence. If the admin sets the disclaimer to whitespace, or the row
 * is deleted, or the database is down — this text still ships.
 */
describe("the fallback disclaimer", () => {
  it("is not empty", () => {
    expect(FALLBACK_DISCLAIMER_TEXT.trim().length).toBeGreaterThan(0);
  });

  it("says it is not medical advice", () => {
    expect(FALLBACK_DISCLAIMER_TEXT.toLowerCase()).toContain("not a medical");
  });

  it("is versioned as the fallback, not as an admin-managed version", () => {
    // `0` is deliberately distinct from the `AiConfig` numbering, which
    // starts at `1`. An audit can therefore tell the two apart: version
    // `0` means "the hardcoded text was shown".
    expect(FALLBACK_DISCLAIMER_VERSION).toBe(0);
  });

  it("is exposed as a frozen-shaped constant", () => {
    expect(FALLBACK_DISCLAIMER.text).toBe(FALLBACK_DISCLAIMER_TEXT);
    expect(FALLBACK_DISCLAIMER.version).toBe(FALLBACK_DISCLAIMER_VERSION);
  });
});
