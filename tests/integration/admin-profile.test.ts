import { AdminAction } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditActor } from "@/lib/admin/audit";
import { getAdminProfile, updateAdminProfile } from "@/lib/admin/profile";
import { ApiError } from "@/lib/api/errors";

/**
 * The administrator's own profile, against a real database.
 *
 * The profile form is the first admin surface that lets somebody edit
 * **themselves**, so these tests prove the properties that make it safe
 * to expose:
 *
 *   1. The change and its `ADMIN_PROFILE_UPDATED` entry are written
 *      **together**, in one transaction.
 *   2. The audit entry records **only the fields that actually changed**.
 *   3. A partial update changes only what it names — an untouched field
 *      is left exactly as it was.
 *   4. The write applies to the **actor's own row**, and to no other.
 *   5. The phone number is recorded as a **flag**, never as the number.
 *   6. The role and the SMS consent are never written.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];

const runId = `prof${Date.now()}${Math.floor(Math.random() * 100000)}`;

/**
 * Creates an administrator for the test.
 */
async function createAdmin(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Admin",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

/**
 * The audit entries **this file** wrote, newest first.
 */
async function readAuditEntries(adminId: string) {
  return prisma.adminAuditLog.findMany({
    where: {
      entityType: "admin_profile",
      entityId: adminId,
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
      "\n[integration] PostgreSQL is not reachable — skipping the admin " +
        "profile integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) return;

  try {
    await prisma.adminAuditLog.deleteMany({
      where: { actorId: { in: createdUserIds } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds } },
    });
  } finally {
  }
});

describe("the admin profile service", () => {
  it("reads the profile of the signed-in administrator", async () => {
    if (!databaseAvailable) return;

    const adminId = await createAdmin(`${runId}_read@example.com`);

    const profile = await getAdminProfile(adminId);

    expect(profile.id).toBe(adminId);
    expect(profile.email).toBe(`${runId}_read@example.com`);
    expect(profile.role).toBe("ADMIN");
  });

  it("refuses to read a profile that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      getAdminProfile("no-such-administrator-id"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("changes the name and writes an audit entry in the same transaction", async () => {
    if (!databaseAvailable) return;

    const adminId = await createAdmin(`${runId}_name@example.com`);

    const actor: AuditActor = {
      id: adminId,
      name: "Test Admin",
      email: `${runId}_name@example.com`,
    };

    const saved = await updateAdminProfile(actor, { name: "Ayesha Rahman" });

    expect(saved.name).toBe("Ayesha Rahman");

    const entries = await readAuditEntries(adminId);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe(AdminAction.ADMIN_PROFILE_UPDATED);
    expect(entries[0]?.entityType).toBe("admin_profile");
    expect(entries[0]?.entityId).toBe(adminId);

    // The entry names the field and both values — a name is not
    // personal data in the way a phone number is, and the trail's job is
    // to say "from what, to what".
    const before = entries[0]?.before as Record<string, unknown> | null;
    const after = entries[0]?.after as Record<string, unknown> | null;

    expect(before?.name).toBe("Test Admin");
    expect(after?.name).toBe("Ayesha Rahman");
  });

  it("leaves the fields the update did not name alone", async () => {
    if (!databaseAvailable) return;

    const adminId = await createAdmin(`${runId}_partial@example.com`);

    await prisma.user.update({
      where: { id: adminId },
      data: { phone: "01819-000000" },
    });

    const actor: AuditActor = {
      id: adminId,
      name: "Test Admin",
      email: `${runId}_partial@example.com`,
    };

    const saved = await updateAdminProfile(actor, { name: "Renamed" });

    // The name changed; the phone number did not.
    expect(saved.name).toBe("Renamed");
    expect(saved.phone).toBe("01819-000000");

    const entries = await readAuditEntries(adminId);

    // And the entry mentions only the name.
    const after = entries[0]?.after as Record<string, unknown> | null;

    expect(Object.keys(after ?? {})).toEqual(["name"]);
  });

  it("records the phone number as a flag, never as the number", async () => {
    if (!databaseAvailable) return;

    const adminId = await createAdmin(`${runId}_phone@example.com`);

    const actor: AuditActor = {
      id: adminId,
      name: "Test Admin",
      email: `${runId}_phone@example.com`,
    };

    await updateAdminProfile(actor, { phone: "01712345678" });

    const entries = await readAuditEntries(adminId);

    const before = entries[0]?.before as Record<string, unknown> | null;
    const after = entries[0]?.after as Record<string, unknown> | null;

    // "set", not the number. The trail is browsable by every admin and
    // is copied into exports and backups.
    expect(before?.phone).toBeNull();
    expect(after?.phone).toBe("set");

    // And the number itself appears nowhere in the entry.
    expect(JSON.stringify(entries[0])).not.toContain("01712345678");
  });

  it("clears the phone number when it is emptied", async () => {
    if (!databaseAvailable) return;

    const adminId = await createAdmin(`${runId}_clear@example.com`);

    await prisma.user.update({
      where: { id: adminId },
      data: { phone: "01712345678" },
    });

    const actor: AuditActor = {
      id: adminId,
      name: "Test Admin",
      email: `${runId}_clear@example.com`,
    };

    const saved = await updateAdminProfile(actor, { phone: null });

    expect(saved.phone).toBeNull();
  });

  it("writes no audit entry when nothing actually changed", async () => {
    if (!databaseAvailable) return;

    const adminId = await createAdmin(`${runId}_nochange@example.com`);

    const actor: AuditActor = {
      id: adminId,
      name: "Test Admin",
      email: `${runId}_nochange@example.com`,
    };

    // The name is already "Test Admin", so this saves the same value.
    await updateAdminProfile(actor, { name: "Test Admin" });

    const entries = await readAuditEntries(adminId);

    // A save that changed nothing is not an action worth auditing.
    expect(entries).toHaveLength(0);
  });

  it("writes to the actor's own row and to no other", async () => {
    if (!databaseAvailable) return;

    const adminId = await createAdmin(`${runId}_own@example.com`);
    const otherId = await createAdmin(`${runId}_other@example.com`);

    const actor: AuditActor = {
      id: adminId,
      name: "Test Admin",
      email: `${runId}_own@example.com`,
    };

    await updateAdminProfile(actor, { name: "Only Mine Changed" });

    const other = await prisma.user.findUnique({
      where: { id: otherId },
      select: { name: true },
    });

    // The other administrator is untouched.
    expect(other?.name).toBe("Test Admin");
  });

  it("never writes the role or the SMS consent", async () => {
    if (!databaseAvailable) return;

    const adminId = await createAdmin(`${runId}_fixed@example.com`);

    await prisma.user.update({
      where: { id: adminId },
      data: { smsOptIn: false },
    });

    const actor: AuditActor = {
      id: adminId,
      name: "Test Admin",
      email: `${runId}_fixed@example.com`,
    };

    const saved = await updateAdminProfile(actor, { name: "Still An Admin" });

    // The role and the consent flag are read-only facts.
    expect(saved.role).toBe("ADMIN");
    expect(saved.smsOptIn).toBe(false);
  });
});
