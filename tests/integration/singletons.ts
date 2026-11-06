import type { AiConfig, SiteSettings } from "@prisma/client";

import {
  DEFAULT_MARQUEE_BG,
  DEFAULT_MARQUEE_TEXT,
} from "@/lib/format/colors";

import { prisma } from "./client";

/**
 * Snapshot-and-restore helpers for the integration suite's **singleton**
 * rows.
 *
 * ── The problem this solves ──────────────────────────────────────────────
 *
 * Two tables hold exactly one row that belongs to the **shop**, not to
 * the test: the site's settings (the announcement marquee, the footer's
 * contact details) and the advisor's configuration (the compliance
 * disclaimer).
 *
 * A test that wants to assert "the marquee is off and has no text" has
 * to put the shop's row into that state. And then it has to put it back.
 *
 * The obvious cleanup — `deleteMany` the row in `afterAll` — is **wrong**,
 * and it is wrong in a way that only shows up later:
 *
 *   1. It **destroys the shop's live configuration.** The admin's
 *      announcement, the shop's support telephone, the disclaimer every
 *      customer sees — all gone, because somebody ran the test suite. The
 *      shop did not ask for that, and no test asserts on it.
 *
 *   2. It is **not idempotent.** After the first run the row does not
 *      exist, so the storefront renders its empty defaults. A second run
 *      then behaves differently from the first — which is how a suite
 *      starts failing for reasons nobody can explain.
 *
 * The rule this file enforces instead is simple: **a test borrows the
 * shop's row and gives it back.**
 *
 * ── Why "give it back" and not "leave it empty" ──────────────────────────
 *
 * Because the difference matters to whoever runs the suite next. A
 * restored row means the suite is invisible from the shop's side — it
 * borrowed a row and returned it, exactly as it found it. An emptied row
 * means the suite left a mark, and the next person to run it has to guess
 * whether the empty state is the shop's or the suite's.
 *
 * So the helpers here **snapshot before the test touches anything** and
 * **restore afterwards**, restoring the row to the state it was in —
 * including "there was no row at all", which is a state worth
 * preserving, because a fresh database legitimately has none.
 */

/**
 * A snapshot of the site's settings row.
 *
 * `null` means "the row did not exist" — which is a real state for a
 * fresh database, and one the restore has to be able to reproduce.
 */
export type SiteSettingsSnapshot = {
  /** The row's own id, kept so the restore puts the row **back**, not a copy. */
  readonly id: string;
  /** The row's fields, minus the id and the timestamp. */
  readonly fields: Omit<SiteSettings, "id" | "updatedAt" | "key">;
};

/**
 * A snapshot of the advisor's configuration row.
 */
export type AiConfigSnapshot = {
  /** The row's own id. */
  readonly id: string;
  /** The row's fields, minus the id and the timestamp. */
  readonly fields: Omit<AiConfig, "id" | "updatedAt" | "key">;
};

/**
 * The single-row key both tables use.
 */
const SETTINGS_KEY = "default";

/**
 * Snapshots the site's settings row.
 *
 * Returns `null` when the row does not exist, so the caller can tell
 * "nothing configured yet" from "configured with these values".
 */
export async function snapshotSiteSettings(): Promise<SiteSettingsSnapshot | null> {
  const row = await prisma.siteSettings.findUnique({
    where: { key: SETTINGS_KEY },
  });

  if (row === null) return null;

  /*
   * The `key`, the id and the timestamp are left out: they are the
   * row's **identity** in the table rather than one of its settings,
   * and the restore always writes the canonical `"default"` and the
   * original id back.
   */
  return {
    id: row.id,
    fields: {
      isMarqueeEnabled: row.isMarqueeEnabled,
      marqueeText: row.marqueeText,
      marqueeHref: row.marqueeHref,
      marqueeBgColor: row.marqueeBgColor,
      marqueeTextColor: row.marqueeTextColor,
      supportEmail: row.supportEmail,
      supportPhone: row.supportPhone,
      supportHours: row.supportHours,
      storeAddress: row.storeAddress,
    },
  };
}

/**
 * Restores the site's settings row to a snapshot.
 *
 * A snapshot of `null` means the row did not exist, so the restore
 * **removes** it — putting the database back exactly as it was, rather
 * than leaving behind a row the shop never had.
 *
 * A real snapshot puts the row back with its **original id**, so any
 * reference to it elsewhere stays valid.
 */
export async function restoreSiteSettings(
  snapshot: SiteSettingsSnapshot | null,
): Promise<void> {
  if (snapshot === null) {
    await prisma.siteSettings.deleteMany({ where: { key: SETTINGS_KEY } });
    return;
  }

  await prisma.siteSettings.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, id: snapshot.id, ...snapshot.fields },
    /*
     * The **id is part of the restore**.
     *
     * A test that deletes the row and then lets the service recreate it
     * leaves a row with a *new* id — a different row, wearing the
     * shop's settings. Writing the id back makes the restore put the
     * shop's own row back, not a copy of it.
     */
    update: { id: snapshot.id, ...snapshot.fields },
  });
}

/**
 * Puts the site's settings row back to a **known baseline**, keeping the
 * row's identity.
 *
 * The tests need a baseline they can reason about: "the marquee is off
 * and has no text", "the ground is the default ink", "there is no
 * contact detail configured". Without that, a test's outcome depends on
 * whatever the shop happens to have configured — which is how a suite
 * passes on one developer's machine and fails on another's.
 *
 * The **id** is kept, so the baseline is the shop's own row with the
 * values zeroed rather than a different row wearing the shop's values.
 */
export async function resetSiteSettingsToBaseline(): Promise<void> {
  const baseline = {
    isMarqueeEnabled: false,
    marqueeText: "",
    marqueeHref: null,
    marqueeBgColor: DEFAULT_MARQUEE_BG,
    marqueeTextColor: DEFAULT_MARQUEE_TEXT,
    supportEmail: "",
    supportPhone: "",
    supportHours: "",
    storeAddress: "",
  };

  const existing = await prisma.siteSettings.findUnique({
    where: { key: SETTINGS_KEY },
    select: { id: true },
  });

  await prisma.siteSettings.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, ...baseline },
    update: baseline,
  });

  /*
   * The row may have been deleted by an earlier test in the file, in
   * which case the upsert created a **new** row with a new id. Writing
   * the original id back makes the baseline the shop's own row rather
   * than a replacement for it.
   */
  if (existing !== null) {
    await prisma.siteSettings.update({
      where: { key: SETTINGS_KEY },
      data: { id: existing.id },
    });
  }
}

/**
 * Snapshots the advisor's configuration row.
 */
export async function snapshotAiConfig(): Promise<AiConfigSnapshot | null> {
  const row = await prisma.aiConfig.findUnique({ where: { key: SETTINGS_KEY } });

  if (row === null) return null;

  /*
   * The `key`, the id and the timestamp are left out: they are the
   * row's **identity** in the table rather than one of its settings,
   * and the restore always writes the canonical `"default"` and the
   * original id back.
   */
  return {
    id: row.id,
    fields: {
      disclaimerText: row.disclaimerText,
      disclaimerVersion: row.disclaimerVersion,
      aiProductIds: row.aiProductIds,
      systemPrompt: row.systemPrompt,
      enforceCartConflicts: row.enforceCartConflicts,
    },
  };
}

/**
 * Puts the advisor's configuration row back to a **known baseline**,
 * keeping the row's identity.
 *
 * The same rule as the settings row's baseline: the tests need a
 * starting state they can reason about, and it has to be the shop's own
 * row with the values zeroed rather than a different row.
 */
export async function resetAiConfigToBaseline(): Promise<void> {
  const baseline = {
    disclaimerText: "The baseline disclaimer the tests start from.",
    disclaimerVersion: 1,
    aiProductIds: [] as string[],
    systemPrompt: null,
    enforceCartConflicts: true,
  };

  const existing = await prisma.aiConfig.findUnique({
    where: { key: SETTINGS_KEY },
    select: { id: true },
  });

  await prisma.aiConfig.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, ...baseline },
    update: baseline,
  });

  if (existing !== null) {
    await prisma.aiConfig.update({
      where: { key: SETTINGS_KEY },
      data: { id: existing.id },
    });
  }
}

/**
 * Restores the advisor's configuration row to a snapshot.
 */
export async function restoreAiConfig(
  snapshot: AiConfigSnapshot | null,
): Promise<void> {
  if (snapshot === null) {
    await prisma.aiConfig.deleteMany({ where: { key: SETTINGS_KEY } });
    return;
  }

  await prisma.aiConfig.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, id: snapshot.id, ...snapshot.fields },
    /*
     * The **id is part of the restore** — see the note in
     * `restoreSiteSettings`.
     */
    update: { id: snapshot.id, ...snapshot.fields },
  });
}
