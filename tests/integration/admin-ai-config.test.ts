import { AdminAction } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { updateAiConfig } from "@/lib/admin/ai-config";
import { type AuditActor } from "@/lib/admin/audit";
import { ApiError } from "@/lib/api/errors";

/**
 * The AI-configuration service, against a real database.
 *
 * Settings is the admin surface that shipped **without** an audit
 * trail, and it is the one that changes *compliance text* — the
 * disclaimer every customer sees during an advisor conversation. So
 * these tests prove the properties that make the trail worth having:
 *
 *   1. The configuration change and its `AI_CONFIG_UPDATED` entry are
 *      written **together**, in one transaction.
 *   2. The audit entry records **only the fields that actually
 *      changed** — a save that touches the allow-list alone does not
 *      reproduce the disclaimer in the log.
 *   3. `disclaimerVersion` is bumped **only when the disclaimer text
 *      changed**, because the stamp's whole job is to identify which
 *      wording a customer was actually shown.
 *   4. A partial update changes only what it names. An untouched field
 *      is left exactly as it was — including the disclaimer.
 *   5. An empty disclaimer is **refused**, and it writes nothing.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";
import {
  resetAiConfigToBaseline,
  restoreAiConfig,
  snapshotAiConfig,
  type AiConfigSnapshot,
} from "./singletons";

let databaseAvailable = false;

const createdUserIds: string[] = [];

const runId = `aic${Date.now()}${Math.floor(Math.random() * 100000)}`;

let actor: AuditActor;

/**
 * The key the config row uses.
 */
const CONFIG_KEY = "default";

/**
 * The shop's advisor configuration, as it was before this file touched
 * it.
 *
 * The config row is a **singleton that belongs to the shop** — its
 * disclaimer is the compliance text every customer sees. So it is
 * borrowed and given back; see `tests/integration/singletons.ts`.
 */
let originalConfig: AiConfigSnapshot | null = null;

/**
 * Reads the audit entries **this file** wrote, newest first.
 *
 * The filter names the test's own admin, because the config row is the
 * shop's row: the shop may have its own history for it, and the tests
 * are counting **their** entries, not everybody's.
 */
async function readAuditEntries() {
  return prisma.adminAuditLog.findMany({
    where: {
      entityType: "ai_config",
      entityId: CONFIG_KEY,
      actorId: { in: createdUserIds },
    },
    orderBy: { createdAt: "desc" },
  });
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the AI " +
        "configuration integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  /*
   * Borrow the shop's advisor configuration before anything in this
   * file changes it, so the restore can put it back exactly as it was.
   */
  originalConfig = await snapshotAiConfig();

  const user = await prisma.user.create({
    data: {
      name: "Test Settings Admin",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Test Settings Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) return;

  /*
   * The config row is a **singleton that belongs to the shop** — its
   * disclaimer is the compliance text every customer sees.
   *
   * Deleting it here would take the shop's own wording with it, and it
   * would leave the database in a state the second run does not see.
   * So the row is **given back** instead: restored to the state it was
   * in before this file ran, down to its original id. If there was no
   * row before, there is no row after.
   */
  await restoreAiConfig(originalConfig);

  /*
   * Only the entries **this file** wrote are removed — the ones that
   * name the test's own admin as the actor. The shop's own history for
   * the same row is left alone.
   */
  await prisma.adminAuditLog.deleteMany({
    where: {
      entityType: "ai_config",
      entityId: CONFIG_KEY,
      actorId: { in: createdUserIds },
    },
  });

  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

/**
 * Puts the borrowed row back to a **known** state before each test.
 *
 * The tests need a baseline they can reason about — "the disclaimer is
 * the default wording, the allow-list is empty, there is no prompt
 * override". Without that, a test's outcome depends on whatever the
 * shop happens to have configured, which is how a suite passes on one
 * developer's machine and fails on another's.
 *
 * So the row is **reset** between tests, and the shop's own row is put
 * back at the end. The two are different things, and the order matters:
 * reset for a known baseline, restore for the shop's sake.
 */
beforeEach(async () => {
  if (!databaseAvailable) return;

  await resetAiConfigToBaseline();

  /*
   * The audit entries are cleared for the same reason: a test that counts
   * entries needs to know the count it started from, and the entries
   * this file wrote are the ones it may remove.
   */
  await prisma.adminAuditLog.deleteMany({
    where: {
      entityType: "ai_config",
      entityId: CONFIG_KEY,
      actorId: { in: createdUserIds },
    },
  });
});

describe("updateAiConfig", () => {
  it("writes the configuration and its audit entry together", async () => {
    if (!databaseAvailable) return;

    const before = await readAuditEntries();

    const result = await updateAiConfig(actor, {
      disclaimerText: "This is guidance, not medical advice.",
    });

    expect(result.config.disclaimerText).toBe(
      "This is guidance, not medical advice.",
    );

    const after = await readAuditEntries();

    expect(after.length).toBe(before.length + 1);

    const entry = after[0];

    expect(entry.action).toBe(AdminAction.AI_CONFIG_UPDATED);
    expect(entry.actorId).toBe(actor.id);
    expect(entry.entityType).toBe("ai_config");
    expect(entry.entityId).toBe(CONFIG_KEY);
  });

  it("bumps the version only when the disclaimer text changes", async () => {
    if (!databaseAvailable) return;

    const first = await updateAiConfig(actor, {
      disclaimerText: "Version one of the disclaimer.",
    });

    expect(first.disclaimerChanged).toBe(true);
    expect(first.config.disclaimerVersion).toBeGreaterThan(0);

    const versionAfterFirst = first.config.disclaimerVersion;

    // A save that touches a *different* field must leave the version
    // alone. The stamp identifies what the customer was shown — moving
    // it on an unrelated save would make it identify nothing.
    const second = await updateAiConfig(actor, {
      enforceCartConflicts: false,
    });

    expect(second.disclaimerChanged).toBe(false);
    expect(second.config.disclaimerVersion).toBe(versionAfterFirst);

    // And a save that names the same text again is not a change either.
    const third = await updateAiConfig(actor, {
      disclaimerText: "Version one of the disclaimer.",
    });

    expect(third.disclaimerChanged).toBe(false);
    expect(third.config.disclaimerVersion).toBe(versionAfterFirst);

    // A genuinely different text does move it.
    const fourth = await updateAiConfig(actor, {
      disclaimerText: "Version two of the disclaimer.",
    });

    expect(fourth.disclaimerChanged).toBe(true);
    expect(fourth.config.disclaimerVersion).toBe(versionAfterFirst + 1);
  });

  it("changes only the fields the patch names", async () => {
    if (!databaseAvailable) return;

    await updateAiConfig(actor, {
      disclaimerText: "A stable disclaimer.",
      systemPrompt: "The original prompt.",
      aiProductIds: ["product-a", "product-b"],
      enforceCartConflicts: true,
    });

    const result = await updateAiConfig(actor, {
      systemPrompt: "A replaced prompt.",
    });

    // The disclaimer is untouched.
    expect(result.config.disclaimerText).toBe("A stable disclaimer.");

    // The allow-list is untouched.
    expect(result.config.aiProductIds).toEqual(["product-a", "product-b"]);

    // The prompt changed.
    expect(result.config.systemPrompt).toBe("A replaced prompt.");

    // The switch is untouched.
    expect(result.config.enforceCartConflicts).toBe(true);
  });

  it("records only the changed fields in the audit entry", async () => {
    if (!databaseAvailable) return;

    await updateAiConfig(actor, {
      disclaimerText: "The audit's before state.",
      systemPrompt: "The audit's prompt.",
    });

    await updateAiConfig(actor, { systemPrompt: "The audit's new prompt." });

    const entries = await readAuditEntries();
    const entry = entries[0];

    const before = entry.before as Record<string, unknown>;
    const after = entry.after as Record<string, unknown>;

    // The prompt is in the entry.
    expect(before.systemPrompt).toBe("The audit's prompt.");
    expect(after.systemPrompt).toBe("The audit's new prompt.");

    // The disclaimer is **not**. A save that changes one field must not
    // reproduce the whole configuration in the log — that is what makes
    // an audit log unreadable.
    expect("disclaimerText" in before).toBe(false);
    expect("disclaimerText" in after).toBe(false);
  });

  it("refuses an empty disclaimer and writes nothing", async () => {
    if (!databaseAvailable) return;

    await updateAiConfig(actor, { disclaimerText: "A good disclaimer." });

    const entriesBefore = await readAuditEntries();

    await expect(
      updateAiConfig(actor, { disclaimerText: "   " }),
    ).rejects.toBeInstanceOf(ApiError);

    const entriesAfter = await readAuditEntries();

    expect(entriesAfter.length).toBe(entriesBefore.length);

    const config = await prisma.aiConfig.findUnique({
      where: { key: CONFIG_KEY },
      select: { disclaimerText: true },
    });

    expect(config?.disclaimerText).toBe("A good disclaimer.");
  });

  it("treats a re-ordered allow-list as unchanged", async () => {
    if (!databaseAvailable) return;

    // The config row is a singleton, and the service refuses to create
    // it from a patch that names only the allow-list — the disclaimer
    // is required and cannot be left blank. So this test has to make
    // sure the row exists before it can say anything about the
    // allow-list.
    //
    // It used to rely on another test in this file having created the
    // row first, which made the outcome depend on the order the file's
    // tests ran in. Establishing the precondition here makes the test
    // self-sufficient: it passes whichever order it runs in.
    await prisma.aiConfig.upsert({
      where: { key: CONFIG_KEY },
      create: {
        key: CONFIG_KEY,
        disclaimerText: "A good disclaimer.",
      },
      update: {},
    });

    await updateAiConfig(actor, {
      aiProductIds: ["one", "two", "three"],
    });

    const entriesBefore = await readAuditEntries();

    const result = await updateAiConfig(actor, {
      aiProductIds: ["three", "one", "two"],
    });

    // The same set of ids in a different order is the same
    // configuration. Re-ordering is not a change worth putting in an
    // audit trail.
    expect(result.config.aiProductIds).toEqual(["three", "one", "two"]);

    const entriesAfter = await readAuditEntries();

    expect(entriesAfter.length).toBe(entriesBefore.length);
  });
});
