import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";

import {
  AI_CONFIG_ACTIONS,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin AI-configuration service.
 *
 * ── Why this exists as its own module ────────────────────────────────────
 *
 * The advisor config was originally writable through a bare `upsert` in
 * the route handler. That is a **mutating admin action with no audit
 * trail**, and every other mutating admin action in this codebase has
 * one. So the write path moves here, where it can share a transaction
 * with its audit entry.
 *
 * Two things are worth stating plainly, because they are the kind of
 * detail that gets lost:
 *
 * **1. `disclaimerVersion` is a stamp, not a setting.**
 *
 * The schema comment says it: *"Bumped whenever disclaimerText changes;
 * stamped onto every message's meta so an audit can prove which version
 * a user actually saw."* If a client could set it directly, two
 * different disclaimers could share a version number — and the stamp,
 * whose entire job is to identify exactly what a customer saw, would
 * become meaningless. So the service owns it: the client never sends
 * it, and the service bumps it **only when the text actually changed**.
 *
 * **2. A partial update changes only what it names.**
 *
 * Every field is optional. An update that names the allow-list alone
 * must not silently reset the disclaimer to the default — that would
 * replace compliance text as a side effect of editing something else.
 * So each field is applied only when it is present, and the audit
 * entry records **only the fields that actually changed**.
 */

/**
 * The config row as the Settings page sees it.
 */
export type AdminAiConfig = {
  key: string;
  disclaimerText: string;
  disclaimerVersion: number;
  aiProductIds: string[];
  systemPrompt: string | null;
  enforceCartConflicts: boolean;
  updatedAt: Date;
};

/**
 * The fields an admin may change.
 *
 * `disclaimerVersion` is deliberately absent — see the note above.
 */
export type AiConfigPatch = {
  readonly disclaimerText?: string;
  readonly aiProductIds?: readonly string[];
  readonly systemPrompt?: string | null;
  readonly enforceCartConflicts?: boolean;
};

/**
 * The Prisma select for the config row.
 */
const AI_CONFIG_SELECT = {
  key: true,
  disclaimerText: true,
  disclaimerVersion: true,
  aiProductIds: true,
  systemPrompt: true,
  enforceCartConflicts: true,
  updatedAt: true,
} satisfies Prisma.AiConfigSelect;

/**
 * The single-row key. The table is guarded to one row by the service
 * layer, and "default" is that row's key.
 */
const CONFIG_KEY = "default";

/**
 * Reads the advisor configuration.
 *
 * Returns `null` when the row has never been created — a fresh
 * database has no config until an admin writes one.
 */
export async function getAiConfig(): Promise<AdminAiConfig | null> {
  const config = await db.aiConfig.findUnique({
    where: { key: CONFIG_KEY },
    select: AI_CONFIG_SELECT,
  });

  return config;
}

/**
 * The fields that differ between two config snapshots.
 *
 * Only the fields that actually changed are recorded, so the audit
 * entry reads "systemPrompt changed" rather than reproducing the whole
 * configuration on every save.
 */
function diffConfig(
  before: AdminAiConfig | null,
  after: AdminAiConfig,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const beforeFields: Record<string, unknown> = {};
  const afterFields: Record<string, unknown> = {};

  const compare = (
    field: keyof AdminAiConfig,
    equal: (a: unknown, b: unknown) => boolean,
  ): void => {
    const previous = before?.[field] ?? null;
    const next = after[field];

    if (equal(previous, next)) return;

    beforeFields[field] = previous;
    afterFields[field] = next;
  };

  compare("disclaimerText", (a, b) => a === b);
  compare("aiProductIds", (a, b) => {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];

    if (left.length !== right.length) return false;

    // Order-insensitive: the same set of ids in a different order is
    // the same configuration, and re-ordering is not a change worth
    // putting in an audit trail.
    const leftSet = new Set(left.map(String));
    const rightSet = new Set(right.map(String));

    if (leftSet.size !== rightSet.size) return false;

    for (const value of leftSet) {
      if (!rightSet.has(value)) return false;
    }

    return true;
  });
  compare("systemPrompt", (a, b) => a === b);
  compare("enforceCartConflicts", (a, b) => a === b);

  return { before: beforeFields, after: afterFields };
}

/**
 * Updates the advisor configuration, atomically with its audit entry.
 *
 * @param actor - The admin making the change.
 * @param patch - The fields to change. Unnamed fields are left alone.
 *
 * @throws ApiError 400 when the disclaimer is empty.
 */
export async function updateAiConfig(
  actor: AuditActor,
  patch: AiConfigPatch,
): Promise<{
  config: AdminAiConfig;
  /** True when the disclaimer text itself changed. */
  disclaimerChanged: boolean;
}> {
  // ── The disclaimer ─────────────────────────────────────────────────────
  //
  // An empty disclaimer is not "no disclaimer". It is a banner that
  // renders as nothing, which a customer cannot see, cannot consent to,
  // and cannot complain about. The compliance rule is enforced here as
  // well as in the schema — a compliance rule deserves a second, visible
  // line of defence at the boundary that owns it.
  if (patch.disclaimerText !== undefined && patch.disclaimerText.trim() === "") {
    throw ApiError.validation(
      "The disclaimer cannot be empty. It is required by the advisor's compliance rules.",
    );
  }

  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const existing = await tx.aiConfig.findUnique({
        where: { key: CONFIG_KEY },
        select: AI_CONFIG_SELECT,
      });

      // The version moves only when the *text* moves. A save that
      // changes the allow-list and leaves the disclaimer alone keeps the
      // version, so the stamp still identifies exactly what the user was
      // shown.
      const disclaimerChanged =
        patch.disclaimerText !== undefined &&
        (existing === null ||
          existing.disclaimerText.trim() !== patch.disclaimerText.trim());

      const disclaimerVersion = disclaimerChanged
        ? (existing?.disclaimerVersion ?? 0) + 1
        : (existing?.disclaimerVersion ?? 1);

      const data = {
        ...(patch.disclaimerText !== undefined
          ? { disclaimerText: patch.disclaimerText.trim() }
          : {}),
        disclaimerVersion,
        ...(patch.aiProductIds !== undefined
          ? { aiProductIds: [...patch.aiProductIds] }
          : {}),
        ...(patch.systemPrompt !== undefined
          ? { systemPrompt: patch.systemPrompt }
          : {}),
        ...(patch.enforceCartConflicts !== undefined
          ? { enforceCartConflicts: patch.enforceCartConflicts }
          : {}),
      };

      // ── Creating the row ────────────────────────────────────────────────
      //
      // The `disclaimerText` column is not nullable, and it cannot be:
      // the disclaimer is compliance text, and a config row that existed
      // without one would mean the advisor could run with no disclaimer
      // at all. So the row can only be *created* with a disclaimer.
      //
      // That means a patch that names only the allow-list cannot create
      // the row — there would be nothing to create it from. The request
      // is refused with a message that says so, rather than silently
      // storing a placeholder disclaimer an admin never wrote.
      if (existing === null && patch.disclaimerText === undefined) {
        throw ApiError.validation(
          "There is no advisor configuration yet. Save a disclaimer text first — the disclaimer is required and cannot be left blank.",
        );
      }

      const saved = await tx.aiConfig.upsert({
        where: { key: CONFIG_KEY },
        create: {
          key: CONFIG_KEY,
          disclaimerText: patch.disclaimerText?.trim() ?? "",
          ...data,
        },
        update: data,
        select: AI_CONFIG_SELECT,
      });

      const { before, after } = diffConfig(existing, saved);

      // A save that changed nothing is not an action worth auditing.
      // Writing an entry with empty `before` and `after` would pad the
      // log with noise and make a real change harder to find.
      if (Object.keys(after).length > 0) {
        await writeAuditEntry(tx, {
          actor,
          action: AI_CONFIG_ACTIONS.updated,
          entityType: "ai_config",
          entityId: CONFIG_KEY,
          before,
          after,
          reason: null,
        });
      }

      return { config: saved, disclaimerChanged };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}
