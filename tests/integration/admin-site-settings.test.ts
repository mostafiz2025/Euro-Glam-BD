import { AdminAction } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSiteSettings,
  updateSiteSettings,
} from "@/lib/admin/site-settings";
import { type AuditActor } from "@/lib/admin/audit";
import { ApiError } from "@/lib/api/errors";
import { listPublicSiteSettings } from "@/lib/catalog/site-settings";
import {
  DEFAULT_MARQUEE_BG,
  DEFAULT_MARQUEE_TEXT,
} from "@/lib/format/colors";

/**
 * The announcement-marquee service, against a real database.
 *
 * The marquee is the shop's **first sentence** — the one line of copy
 * published on every page without being asked. So these tests prove the
 * properties that make the trail and the rules worth having:
 *
 *   1. The settings change and its `SITE_SETTINGS_UPDATED` entry are
 *      written **together**, in one transaction.
 *   2. The audit entry records **only the fields that actually
 *      changed** — a save that flips the switch alone does not reproduce
 *      the message in the log.
 *   3. A partial update changes only what it names. An untouched field
 *      is left exactly as it was — including the message.
 *   4. Switching the marquee **on** with no text to show is **refused**,
 *      and it writes nothing.
 *   5. Switching the marquee **off** while the text is still there is
 *      **allowed**, and the text is preserved — that is how an admin
 *      pauses a campaign.
 *   6. The storefront half defends itself: a row that is switched on but
 *      empty renders as no announcement at all.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";
import {
  resetSiteSettingsToBaseline,
  restoreSiteSettings,
  snapshotSiteSettings,
  type SiteSettingsSnapshot,
} from "./singletons";

let databaseAvailable = false;

const createdUserIds: string[] = [];

const runId = `sis${Date.now()}${Math.floor(Math.random() * 100000)}`;

let actor: AuditActor;

/**
 * The key the settings row uses.
 */
const SETTINGS_KEY = "default";

/**
 * The shop's settings, as they were before this file touched them.
 *
 * The settings row is a **singleton that belongs to the shop**, not to
 * the test. So it is borrowed and given back — see
 * `tests/integration/singletons.ts` for why deleting it would be wrong.
 */
let originalSettings: SiteSettingsSnapshot | null = null;

/**
 * Reads the audit entries **this file** wrote, newest first.
 *
 * The filter names the test's own admin, because the settings row is
 * the shop's row: the shop may have its own history for it, and the
 * tests are counting **their** entries, not everybody's.
 */
async function readAuditEntries() {
  return prisma.adminAuditLog.findMany({
    where: {
      entityType: "site_settings",
      entityId: SETTINGS_KEY,
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
      "\n[integration] PostgreSQL is not reachable — skipping the site " +
        "settings integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  /*
   * Borrow the shop's settings before anything in this file changes
   * them, so the restore can put them back exactly as they were.
   */
  originalSettings = await snapshotSiteSettings();

  const user = await prisma.user.create({
    data: {
      name: "Test Marquee Admin",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Test Marquee Admin",
    email: `${runId}_admin@example.com`,
  };
});

/**
 * Puts the borrowed row back to a **known** state before each test.
 *
 * The tests need a baseline they can reason about: "the marquee is off
 * and has no text", "the ground is the default ink", "there is no
 * contact detail configured". Without that, a test's outcome depends on
 * whatever the shop happens to have configured — which is how a suite
 * passes on one developer's machine and fails on another's.
 *
 * So the row is **reset** between tests, and the shop's own row is put
 * back at the end. The two are different things, and the order matters:
 * reset for a known baseline, restore for the shop's sake.
 */
beforeEach(async () => {
  if (!databaseAvailable) return;

  await resetSiteSettingsToBaseline();

  /*
   * The audit entries are cleared for the same reason: a test that counts
   * entries needs to know the count it started from, and the entries
   * this file wrote are the ones it may remove.
   */
  await prisma.adminAuditLog.deleteMany({
    where: {
      entityType: "site_settings",
      entityId: SETTINGS_KEY,
      actorId: { in: createdUserIds },
    },
  });
});

afterAll(async () => {
  if (!databaseAvailable) return;

  /*
   * The settings row is a **singleton that belongs to the shop**.
   *
   * Deleting it here would take the admin's live announcement and the
   * shop's support details with it, and it would leave the database in a
   * state the second run does not see — which is how a suite starts
   * failing for reasons nobody can explain.
   *
   * So the row is **given back** instead: restored to the state it was
   * in before this file ran, down to its original id. If there was no
   * row before, there is no row after.
   */
  await restoreSiteSettings(originalSettings);

  /*
   * The audit entries are scoped to the settings row, which is the only
   * entity this file changed. But the entries the *shop's own* history
   * would hold are on the same row — so the entries written **by this
   * file** are the ones removed, and the shop's are left alone.
   *
   * The entries this file wrote all name the test's own admin as the
   * actor, which is what identifies them.
   */
  await prisma.adminAuditLog.deleteMany({
    where: {
      entityType: "site_settings",
      entityId: SETTINGS_KEY,
      actorId: { in: createdUserIds },
    },
  });

  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("updateSiteSettings", () => {
  it("writes the settings and its audit entry together", async () => {
    if (!databaseAvailable) return;

    const before = await readAuditEntries();

    const result = await updateSiteSettings(actor, {
      marqueeText: "Complimentary delivery on orders over ৳2,000.",
    });

    expect(result.marqueeText).toBe(
      "Complimentary delivery on orders over ৳2,000.",
    );

    const after = await readAuditEntries();

    expect(after.length).toBe(before.length + 1);

    const entry = after[0];

    expect(entry.action).toBe(AdminAction.SITE_SETTINGS_UPDATED);
    expect(entry.actorId).toBe(actor.id);
    expect(entry.entityType).toBe("site_settings");
    expect(entry.entityId).toBe(SETTINGS_KEY);
  });

  it("changes only the fields the patch names", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, {
      marqueeText: "A stable announcement.",
      marqueeHref: "/category/skincare",
      isMarqueeEnabled: true,
    });

    const result = await updateSiteSettings(actor, {
      isMarqueeEnabled: false,
    });

    // The message is untouched.
    expect(result.marqueeText).toBe("A stable announcement.");

    // The link is untouched.
    expect(result.marqueeHref).toBe("/category/skincare");

    // The switch changed.
    expect(result.isMarqueeEnabled).toBe(false);
  });

  it("records only the changed fields in the audit entry", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, {
      marqueeText: "The audit's before state.",
      isMarqueeEnabled: true,
    });

    await updateSiteSettings(actor, { isMarqueeEnabled: false });

    const entries = await readAuditEntries();
    const entry = entries[0];

    const before = entry.before as Record<string, unknown>;
    const after = entry.after as Record<string, unknown>;

    // The switch is in the entry.
    expect(before.isMarqueeEnabled).toBe(true);
    expect(after.isMarqueeEnabled).toBe(false);

    // The message is **not**. A save that changes one field must not
    // reproduce the whole row in the log — that is what makes an audit
    // log unreadable.
    expect("marqueeText" in before).toBe(false);
    expect("marqueeText" in after).toBe(false);
  });

  it("refuses to switch the marquee on with no text to show", async () => {
    if (!databaseAvailable) return;

    /*
     * The rule is about the **stored** state: a request that switches
     * the marquee on without naming the text is switching on whatever
     * is already saved, and only the service can see what that is.
     *
     * So the test puts the row into "off, and no message" — which the
     * schema cannot produce, because it refuses an empty message — and
     * then flips the switch *without* naming a text. The stored text is
     * empty, so the request must be refused.
     */
    await prisma.siteSettings.upsert({
      where: { key: SETTINGS_KEY },
      create: {
        key: SETTINGS_KEY,
        isMarqueeEnabled: false,
        marqueeText: "",
      },
      update: { isMarqueeEnabled: false, marqueeText: "" },
    });

    const entriesBefore = await readAuditEntries();

    await expect(
      updateSiteSettings(actor, { isMarqueeEnabled: true }),
    ).rejects.toBeInstanceOf(ApiError);

    const entriesAfter = await readAuditEntries();

    expect(entriesAfter.length).toBe(entriesBefore.length);

    // The refused write left the row exactly as it was — off, and with
    // nothing to say.
    const settings = await prisma.siteSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { isMarqueeEnabled: true, marqueeText: true },
    });

    expect(settings?.isMarqueeEnabled).toBe(false);
    expect(settings?.marqueeText).toBe("");
  });

  it("switches the marquee on using the text that is already saved", async () => {
    if (!databaseAvailable) return;

    /*
     * The converse of the rule: a request that switches the marquee on
     * *without* naming a text is switching on the stored one. So it is
     * allowed — provided that stored text is not empty.
     */
    await updateSiteSettings(actor, {
      marqueeText: "An already-saved announcement.",
      isMarqueeEnabled: false,
    });

    const result = await updateSiteSettings(actor, {
      isMarqueeEnabled: true,
    });

    expect(result.isMarqueeEnabled).toBe(true);
    expect(result.marqueeText).toBe("An already-saved announcement.");
  });

  it("allows the marquee to be switched off while the text stays", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, {
      marqueeText: "A paused campaign.",
      isMarqueeEnabled: true,
    });

    const result = await updateSiteSettings(actor, {
      isMarqueeEnabled: false,
    });

    // The converse of the rule is deliberately allowed: switching the
    // marquee off while the text is still there is how an admin pauses
    // a campaign, and the text is preserved so switching it back on
    // restores the message rather than losing it.
    expect(result.isMarqueeEnabled).toBe(false);
    expect(result.marqueeText).toBe("A paused campaign.");
  });

  it("writes no audit entry for a save that changes nothing", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, {
      marqueeText: "An unchanged announcement.",
      isMarqueeEnabled: true,
    });

    const entriesBefore = await readAuditEntries();

    await updateSiteSettings(actor, {
      marqueeText: "An unchanged announcement.",
      isMarqueeEnabled: true,
    });

    const entriesAfter = await readAuditEntries();

    expect(entriesAfter.length).toBe(entriesBefore.length);
  });

  it("trims the message and clears a blank link to null", async () => {
    if (!databaseAvailable) return;

    const result = await updateSiteSettings(actor, {
      marqueeText: "   A trimmed announcement.   ",
      marqueeHref: "   ",
    });

    expect(result.marqueeText).toBe("A trimmed announcement.");
    expect(result.marqueeHref).toBeNull();
  });
});

describe("updateSiteSettings — the colours", () => {
  it("stores a legible pair", async () => {
    if (!databaseAvailable) return;

    const result = await updateSiteSettings(actor, {
      marqueeBgColor: "#be185d",
      marqueeTextColor: "#ffffff",
    });

    expect(result.marqueeBgColor).toBe("#be185d");
    expect(result.marqueeTextColor).toBe("#ffffff");
  });

  it("refuses a pair that is too faint to read, and writes nothing", async () => {
    if (!databaseAvailable) return;

    /*
     * A pale rose ground with white type is a valid pair of colours and
     * an unreadable bar. The bar is on every page of the shop, saying
     * something nobody can read — so the pair is refused before it is
     * stored rather than after a customer has complained.
     */
    await updateSiteSettings(actor, {
      marqueeBgColor: "#1c1917",
      marqueeTextColor: "#ffffff",
    });

    await expect(
      updateSiteSettings(actor, { marqueeBgColor: "#fce7f3" }),
    ).rejects.toBeInstanceOf(ApiError);

    const settings = await prisma.siteSettings.findUnique({
      where: { key: SETTINGS_KEY },
      select: { marqueeBgColor: true },
    });

    expect(settings?.marqueeBgColor).toBe("#1c1917");
  });

  it("checks the pair that would be in force afterwards", async () => {
    if (!databaseAvailable) return;

    /*
     * A request that changes only the ground is changing the pair, so
     * the type it is checked against is the one already stored. The
     * stored type here is white, and a blush ground with white type
     * fails the threshold — so the request must be refused even though
     * it never mentioned the type.
     */
    await updateSiteSettings(actor, {
      marqueeBgColor: "#1c1917",
      marqueeTextColor: "#ffffff",
    });

    await expect(
      updateSiteSettings(actor, { marqueeBgColor: "#fce7f3" }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("allows a pale ground when the type is dark enough", async () => {
    if (!databaseAvailable) return;

    /*
     * The rule is about **legibility**, not about one colour being
     * forbidden. A blush ground with the brand's deep rose type is a
     * perfectly good pair, and the shop's own preset.
     */
    const result = await updateSiteSettings(actor, {
      marqueeBgColor: "#fce7f3",
      marqueeTextColor: "#9d174d",
    });

    expect(result.marqueeBgColor).toBe("#fce7f3");
    expect(result.marqueeTextColor).toBe("#9d174d");
  });

  it("leaves the colours alone when the patch names none", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, {
      marqueeBgColor: "#be185d",
      marqueeTextColor: "#ffffff",
    });

    const result = await updateSiteSettings(actor, {
      marqueeText: "A new announcement.",
    });

    expect(result.marqueeBgColor).toBe("#be185d");
    expect(result.marqueeTextColor).toBe("#ffffff");
  });
});

describe("updateSiteSettings — the contact details", () => {
  it("stores the details and trims them", async () => {
    if (!databaseAvailable) return;

    const result = await updateSiteSettings(actor, {
      supportEmail: "  hello@euroglam.bd  ",
      supportPhone: "  +880 1819-000000  ",
      supportHours: "  Saturday to Thursday, 10am–8pm  ",
      storeAddress: "  House 12, Road 5, Dhanmondi  ",
    });

    expect(result.supportEmail).toBe("hello@euroglam.bd");
    expect(result.supportPhone).toBe("+880 1819-000000");
    expect(result.supportHours).toBe("Saturday to Thursday, 10am–8pm");
    expect(result.storeAddress).toBe("House 12, Road 5, Dhanmondi");
  });

  it("clears a detail when the admin sends an empty one", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, { supportPhone: "01819-000000" });

    const result = await updateSiteSettings(actor, { supportPhone: "" });

    // An empty detail is a real state: the footer shows no phone line.
    expect(result.supportPhone).toBe("");
  });

  it("records the contact details in the audit entry", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, { supportEmail: "before@example.com" });

    await updateSiteSettings(actor, { supportEmail: "after@example.com" });

    const entries = await readAuditEntries();
    const entry = entries[0];

    const before = entry.before as Record<string, unknown>;
    const after = entry.after as Record<string, unknown>;

    expect(before.supportEmail).toBe("before@example.com");
    expect(after.supportEmail).toBe("after@example.com");
  });
});

describe("getSiteSettings", () => {
  it("returns null when nothing has ever been saved", async () => {
    if (!databaseAvailable) return;

    await prisma.siteSettings.deleteMany({ where: { key: SETTINGS_KEY } });

    expect(await getSiteSettings()).toBeNull();
  });

  it("returns the row once it exists", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, {
      marqueeText: "A saved announcement.",
      isMarqueeEnabled: true,
    });

    const settings = await getSiteSettings();

    expect(settings?.key).toBe(SETTINGS_KEY);
    expect(settings?.marqueeText).toBe("A saved announcement.");
    expect(settings?.isMarqueeEnabled).toBe(true);
  });
});

describe("listPublicSiteSettings", () => {
  it("returns the empty settings when the row does not exist", async () => {
    if (!databaseAvailable) return;

    await prisma.siteSettings.deleteMany({ where: { key: SETTINGS_KEY } });

    const settings = await listPublicSiteSettings();

    expect(settings.isMarqueeEnabled).toBe(false);
    expect(settings.marqueeText).toBe("");
    expect(settings.marqueeHref).toBeNull();
  });

  it("returns the settings when the marquee is switched on", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, {
      marqueeText: "A public announcement.",
      marqueeHref: "/products",
      isMarqueeEnabled: true,
    });

    const settings = await listPublicSiteSettings();

    expect(settings.isMarqueeEnabled).toBe(true);
    expect(settings.marqueeText).toBe("A public announcement.");
    expect(settings.marqueeHref).toBe("/products");
  });

  it("defends itself against a row that is switched on but empty", async () => {
    if (!databaseAvailable) return;

    /*
     * The database is not a validator. A row written by a migration, a
     * script or a future admin feature could carry "on with no text",
     * and an announcement with nothing to say renders as a strip of
     * coloured nothing that looks broken.
     */
    await prisma.siteSettings.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, isMarqueeEnabled: true, marqueeText: "" },
      update: { isMarqueeEnabled: true, marqueeText: "" },
    });

    const settings = await listPublicSiteSettings();

    expect(settings.isMarqueeEnabled).toBe(false);
    expect(settings.marqueeText).toBe("");
  });

  it("normalises a colour that is not a colour back to the default", async () => {
    if (!databaseAvailable) return;

    /*
     * The colours are rendered into a `style` attribute, so a row
     * carrying something that is not a colour must not reach the
     * browser. A row written by hand, by a script, or by an older
     * version of the admin route could hold anything — and the bar
     * must still be painted.
     *
     * The column is a `VarChar(7)`, so the database itself bounds the
     * value to the length of a hex triplet. That is a second line of
     * defence behind the normaliser, and it is why the value here is
     * short: the point is that a *short* value which is not a colour is
     * still refused.
     */
    await prisma.siteSettings.upsert({
      where: { key: SETTINGS_KEY },
      create: {
        key: SETTINGS_KEY,
        isMarqueeEnabled: false,
        marqueeText: "",
        marqueeBgColor: "red",
        marqueeTextColor: "#gggggg",
      },
      update: {
        marqueeBgColor: "red",
        marqueeTextColor: "#gggggg",
      },
    });

    const settings = await listPublicSiteSettings();

    expect(settings.marqueeBgColor).toBe(DEFAULT_MARQUEE_BG);
    expect(settings.marqueeTextColor).toBe(DEFAULT_MARQUEE_TEXT);
  });

  it("folds an uppercase colour to its canonical form", async () => {
    if (!databaseAvailable) return;

    await prisma.siteSettings.upsert({
      where: { key: SETTINGS_KEY },
      create: {
        key: SETTINGS_KEY,
        isMarqueeEnabled: false,
        marqueeText: "",
        marqueeBgColor: "#BE185D",
      },
      update: { marqueeBgColor: "#BE185D" },
    });

    const settings = await listPublicSiteSettings();

    // One canonical spelling per colour, so the audit log's "before" and
    // "after" cannot disagree about whether `#FFF` changed.
    expect(settings.marqueeBgColor).toBe("#be185d");
  });

  it("returns the contact details the shop has configured", async () => {
    if (!databaseAvailable) return;

    await updateSiteSettings(actor, {
      supportEmail: "hello@euroglam.bd",
      supportPhone: "01819-000000",
      supportHours: "Saturday to Thursday, 10am–8pm",
      storeAddress: "House 12, Road 5, Dhanmondi\nDhaka 1209",
    });

    const settings = await listPublicSiteSettings();

    expect(settings.supportEmail).toBe("hello@euroglam.bd");
    expect(settings.supportPhone).toBe("01819-000000");
    expect(settings.supportHours).toBe("Saturday to Thursday, 10am–8pm");
    expect(settings.storeAddress).toContain("\n");
  });

  it("returns empty contact details when the shop has configured none", async () => {
    if (!databaseAvailable) return;

    await prisma.siteSettings.deleteMany({ where: { key: SETTINGS_KEY } });

    const settings = await listPublicSiteSettings();

    // A shop that has told us nothing gets no lines in the footer — not
    // placeholder lines.
    expect(settings.supportEmail).toBe("");
    expect(settings.supportPhone).toBe("");
    expect(settings.supportHours).toBe("");
    expect(settings.storeAddress).toBe("");
  });
});
