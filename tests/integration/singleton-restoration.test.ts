import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { updateSiteSettings } from "@/lib/admin/site-settings";
import { type AuditActor } from "@/lib/admin/audit";

import { prisma } from "./client";
import {
  restoreSiteSettings,
  snapshotSiteSettings,
  type SiteSettingsSnapshot,
} from "./singletons";

/**
 * The suite's own promise to the shop.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The settings row is a **singleton that belongs to the shop**, not to
 * the test. The admin's announcement and the shop's support telephone
 * live in it, and the suite has to be able to borrow it without
 * destroying it.
 *
 * The old cleanup deleted the row. That was wrong in two ways:
 *
 *   1. It took the shop's live configuration with it — the announcement
 *      was gone, the footer's contact details were gone, and nobody
 *      asked for that.
 *
 *   2. It was **not idempotent**. The first run left no row, so the
 *      storefront rendered its empty defaults; the second run started
 *      from a different place than the first did. A suite that behaves
 *      differently on its second run is a suite nobody can trust.
 *
 * So the rule is: **a test borrows the shop's row and gives it back**,
 * down to its original id — and a database that had no row ends with no
 * row.
 *
 * ── Why these tests are in their own file ────────────────────────────────
 *
 * Because the property under test is about the **helper**, not about
 * the marquee. The site-settings file proves the *service* behaves; this
 * file proves the *suite* behaves. Putting them together would let one
 * file's `beforeEach` mask the other's mistake — which is exactly what
 * happened before.
 */

let databaseAvailable = false;

const createdUserIds: string[] = [];

const runId = `sng${Date.now()}${Math.floor(Math.random() * 100000)}`;

let actor: AuditActor;

/**
 * The shop's settings, as they were before this file touched them.
 *
 * This file deletes and rewrites the settings row on purpose — it is
 * testing exactly that. So it owes the shop the same courtesy every
 * other file owes it: borrow the row, and give it back at the end.
 */
let originalSettings: SiteSettingsSnapshot | null = null;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the " +
        "singleton restoration integration tests.\n[integration] Set " +
        "DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  originalSettings = await snapshotSiteSettings();

  const user = await prisma.user.create({
    data: {
      name: "Test Restoration Admin",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Test Restoration Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) return;

  /*
   * This file rewrites the settings row on purpose, so it gives the
   * shop's row back at the end — the same rule it is testing.
   */
  await restoreSiteSettings(originalSettings);

  /*
   * The audit entries this file wrote are removed, and only those: they
   * name the test's own admin as the actor.
   */
  await prisma.adminAuditLog.deleteMany({
    where: {
      entityType: "site_settings",
      entityId: "default",
      actorId: { in: createdUserIds },
    },
  });

  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

/**
 * Writes a row with values that are unmistakably the shop's own.
 */
async function writeShopRow(): Promise<void> {
  await updateSiteSettings(actor, {
    isMarqueeEnabled: true,
    marqueeText: "The shop's own announcement.",
    marqueeHref: "/category/skincare",
    marqueeBgColor: "#be185d",
    marqueeTextColor: "#ffffff",
    supportEmail: "hello@euroglam.bd",
    supportPhone: "+880 1819-000000",
    supportHours: "Saturday to Thursday, 10am–8pm",
    storeAddress: "House 12, Road 5, Dhanmondi\nDhaka 1209",
  });
}

describe("the singleton helpers", () => {
  it("gives the shop's row back exactly as it was", async () => {
    if (!databaseAvailable) return;

    await writeShopRow();

    const snapshot = await snapshotSiteSettings();

    expect(snapshot).not.toBeNull();

    // The test changes the row while it holds it.
    await updateSiteSettings(actor, {
      marqueeText: "Something the test wrote.",
      isMarqueeEnabled: false,
      supportEmail: "",
    });

    await restoreSiteSettings(snapshot);

    const row = await prisma.siteSettings.findUnique({
      where: { key: "default" },
    });

    // Every field the shop had set is back.
    expect(row?.isMarqueeEnabled).toBe(true);
    expect(row?.marqueeText).toBe("The shop's own announcement.");
    expect(row?.marqueeHref).toBe("/category/skincare");
    expect(row?.marqueeBgColor).toBe("#be185d");
    expect(row?.marqueeTextColor).toBe("#ffffff");
    expect(row?.supportEmail).toBe("hello@euroglam.bd");
    expect(row?.supportPhone).toBe("+880 1819-000000");
    expect(row?.supportHours).toBe("Saturday to Thursday, 10am–8pm");
    expect(row?.storeAddress).toBe(
      "House 12, Road 5, Dhanmondi\nDhaka 1209",
    );
  });

  it("puts the row back under its original id", async () => {
    if (!databaseAvailable) return;

    await writeShopRow();

    const snapshot = await snapshotSiteSettings();

    expect(snapshot).not.toBeNull();

    await restoreSiteSettings(snapshot);

    const row = await prisma.siteSettings.findUnique({
      where: { key: "default" },
      select: { id: true },
    });

    // The same row, not a replacement. A different id would break any
    // reference to it elsewhere and would make the restore look like an
    // insert.
    expect(row?.id).toBe(snapshot?.id);
  });

  it("leaves no row behind when there was no row to begin with", async () => {
    if (!databaseAvailable) return;

    await prisma.siteSettings.deleteMany({ where: { key: "default" } });

    const snapshot = await snapshotSiteSettings();

    // A fresh database legitimately has no settings row.
    expect(snapshot).toBeNull();

    await writeShopRow();

    await restoreSiteSettings(snapshot);

    const row = await prisma.siteSettings.findUnique({
      where: { key: "default" },
    });

    // The restore put the database back exactly as it was.
    expect(row).toBeNull();
  });

  it("is idempotent — restoring twice gives the same result", async () => {
    if (!databaseAvailable) return;

    await writeShopRow();

    const snapshot = await snapshotSiteSettings();

    await restoreSiteSettings(snapshot);
    await restoreSiteSettings(snapshot);

    const row = await prisma.siteSettings.findUnique({
      where: { key: "default" },
      select: { id: true, marqueeText: true },
    });

    expect(row?.id).toBe(snapshot?.id);
    expect(row?.marqueeText).toBe("The shop's own announcement.");
  });

  it("gives the row back under its id even after it was deleted", async () => {
    if (!databaseAvailable) return;

    await writeShopRow();

    const snapshot = await snapshotSiteSettings();

    /*
     * A test that deletes the row and then lets the service recreate it
     * leaves a row with a **new** id — a different row, wearing the
     * shop's settings. The restore has to put the shop's own row back.
     */
    await prisma.siteSettings.deleteMany({ where: { key: "default" } });

    await writeShopRow();

    await restoreSiteSettings(snapshot);

    const row = await prisma.siteSettings.findUnique({
      where: { key: "default" },
      select: { id: true, marqueeText: true },
    });

    expect(row?.id).toBe(snapshot?.id);
    expect(row?.marqueeText).toBe("The shop's own announcement.");
  });
});
