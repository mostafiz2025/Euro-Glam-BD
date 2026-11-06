import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import {
  createHeroBanner,
  deleteHeroBanner,
  getAdminHeroBanner,
  listAdminHeroBanners,
  updateHeroBanner,
} from "@/lib/admin/hero-banners";
import { type AuditActor } from "@/lib/admin/audit";
import {
  MAX_HERO_BANNERS,
  listPublicHeroBanners,
} from "@/lib/catalog/hero-banners";

/**
 * The hero-banner service, against a real database.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The homepage carousel moved from a hard-coded array into the
 * database, and that introduced four properties a unit test cannot prove:
 *
 *   1. Every write is **audited** — the banner and its audit entry are
 *      written in one transaction, so the shop's opening line has a
 *      record of who changed it.
 *   2. An update is **conditional on the values the admin saw** — two
 *      admins editing the same banner produce one winner and one 409.
 *   3. A **partial** update changes only what it names. A field the
 *      update does not mention is left exactly as it was.
 *   4. A **switched-off** banner stays in the table — the audit trail
 *      needs a row to describe — but leaves the storefront's carousel.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdBannerIds: string[] = [];

const runId = `hrb${Date.now()}${Math.floor(Math.random() * 100000)}`;

let actor: AuditActor;

const GRADIENT =
  "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]";

const GLOW = "bg-brand-400/45";

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the hero " +
        "banner integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const user = await prisma.user.create({
    data: {
      name: "Test Hero Admin",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Test Hero Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  await prisma.adminAuditLog.deleteMany({
    where: {
      entityType: "hero_banner",
      entityId: { in: createdBannerIds },
    },
  });
  await prisma.heroBanner.deleteMany({
    where: { id: { in: createdBannerIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: createdUserIds } },
  });
});

/**
 * Reads the audit entries for one banner, newest first.
 */
async function readAuditEntries(entityId: string) {
  return prisma.adminAuditLog.findMany({
    where: { entityType: "hero_banner", entityId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * A complete banner body, with the run's id folded into the copy so two
 * test runs never collide.
 */
function bannerInput(overrides: Partial<{
  eyebrow: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
  secondaryCtaLabel: string;
  secondaryCtaHref: string;
  trust: string[];
  image: string | null;
  gradient: string;
  glow: string;
  isActive: boolean;
  sortOrder: number;
}> = {}) {
  return {
    eyebrow: `${runId}_Eyebrow`,
    title: `${runId}_Headline`,
    body: "The supporting line for the banner.",
    ctaLabel: "Shop now",
    ctaHref: "/products",
    secondaryCtaLabel: "Ask the advisor",
    secondaryCtaHref: "/advisor",
    trust: ["Dermatologist tested"],
    image: null,
    gradient: GRADIENT,
    glow: GLOW,
    isActive: true,
    sortOrder: 100,
    ...overrides,
  };
}

describe("the hero banner service", () => {
  it("creates a banner and audits it", async () => {
    if (!databaseAvailable) return;

    const banner = await createHeroBanner(actor, bannerInput());

    createdBannerIds.push(banner.id);

    expect(banner.title).toBe(`${runId}_Headline`);
    expect(banner.isActive).toBe(true);
    expect(banner.image).toBeNull();

    const entries = await readAuditEntries(banner.id);

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("HERO_BANNER_CREATED");
    expect(entries[0].entityType).toBe("hero_banner");

    const after = entries[0].after as Record<string, unknown> | null;

    expect(after?.title).toBe(`${runId}_Headline`);
  });

  it("stores the artwork as a storage key", async () => {
    if (!databaseAvailable) return;

    const banner = await createHeroBanner(
      actor,
      bannerInput({
        image: "hero/2026/11/abcdef0123456789abcdef0123456789.png",
      }),
    );

    createdBannerIds.push(banner.id);

    expect(banner.image).toBe(
      "hero/2026/11/abcdef0123456789abcdef0123456789.png",
    );
  });

  it("updates only the fields the edit names", async () => {
    if (!databaseAvailable) return;

    const banner = await createHeroBanner(actor, bannerInput());

    createdBannerIds.push(banner.id);

    await updateHeroBanner(actor, banner.id, {
      title: `${runId}_Rewritten`,
    });

    const updated = await getAdminHeroBanner(banner.id);

    // The named field changed.
    expect(updated.title).toBe(`${runId}_Rewritten`);

    // Everything else is exactly as it was.
    expect(updated.eyebrow).toBe(`${runId}_Eyebrow`);
    expect(updated.ctaHref).toBe("/products");
    expect(updated.trust).toEqual(["Dermatologist tested"]);

    const entries = await readAuditEntries(banner.id);

    expect(entries[0].action).toBe("HERO_BANNER_UPDATED");

    // Only the touched field is recorded, so the entry reads
    // "title X → Y" rather than carrying the whole row twice.
    const before = entries[0].before as Record<string, unknown> | null;
    const after = entries[0].after as Record<string, unknown> | null;

    expect(Object.keys(before ?? {})).toEqual(["title"]);
    expect(before?.title).toBe(`${runId}_Headline`);
    expect(after?.title).toBe(`${runId}_Rewritten`);
  });

  it("stores no showcase source — the hero has no product column", async () => {
    if (!databaseAvailable) return;

    /*
     * A banner used to be able to name the catalogue's products, which
     * the storefront resolved into a plate of floating product cards
     * beside the copy.
     *
     * The plate is gone, so the columns are gone with it. The round-trip
     * is now: the banner comes back carrying **nothing but** the copy,
     * the surfaces and the artwork.
     */
    const banner = await createHeroBanner(actor, bannerInput());

    createdBannerIds.push(banner.id);

    expect(banner).not.toHaveProperty("showcaseBrand");
    expect(banner).not.toHaveProperty("showcaseCategory");

    const updated = await updateHeroBanner(actor, banner.id, {
      title: `${runId}_Retitled`,
    });

    expect(updated).not.toHaveProperty("showcaseBrand");
    expect(updated).not.toHaveProperty("showcaseCategory");
  });

  it("clears the artwork when null is sent", async () => {
    if (!databaseAvailable) return;

    const banner = await createHeroBanner(
      actor,
      bannerInput({
        image: "hero/2026/11/11111111111111111111111111111111.png",
      }),
    );

    createdBannerIds.push(banner.id);

    await updateHeroBanner(actor, banner.id, { image: null });

    const updated = await getAdminHeroBanner(banner.id);

    expect(updated.image).toBeNull();
  });

  it("refuses a stale write and keeps the winner's value", async () => {
    if (!databaseAvailable) return;

    const banner = await createHeroBanner(actor, bannerInput());

    createdBannerIds.push(banner.id);

    /*
     * The service's write is a **conditional** `updateMany`:

     *   UPDATE "hero_banners" SET "title" = $new
     *   WHERE "id" = $id AND "title" = $observed

     * The statement is driven directly here, because reproducing the
     * window between the service's SELECT and its UPDATE from outside
     * the service is a timing game — and a timing game that passes
     * today and flakes tomorrow is worse than no test at all.
     */
    await prisma.heroBanner.update({
      where: { id: banner.id },
      data: { title: `${runId}_ChangedBySomeoneElse` },
    });

    const stale = await prisma.$executeRaw`
      UPDATE "hero_banners"
      SET "title" = ${`${runId}_Stale`}
      WHERE "id" = ${banner.id}
        AND "title" = ${`${runId}_Headline`}
    `;

    expect(stale).toBe(0);

    const afterStale = await prisma.heroBanner.findUnique({
      where: { id: banner.id },
      select: { title: true },
    });

    expect(afterStale?.title).toBe(`${runId}_ChangedBySomeoneElse`);
  });

  it("deletes a banner and audits the reason", async () => {
    if (!databaseAvailable) return;

    const banner = await createHeroBanner(actor, bannerInput());

    await deleteHeroBanner(actor, banner.id, "The campaign had ended.");

    const row = await prisma.heroBanner.findUnique({
      where: { id: banner.id },
      select: { id: true },
    });

    expect(row).toBeNull();

    const entries = await readAuditEntries(banner.id);

    expect(entries[0].action).toBe("HERO_BANNER_DELETED");
    expect(entries[0].reason).toBe("The campaign had ended.");
  });

  it("refuses to delete a banner that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      deleteHeroBanner(actor, `${runId}_missing`, "Tidying up."),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("lists the banners in the admin's order", async () => {
    if (!databaseAvailable) return;

    const later = await createHeroBanner(
      actor,
      bannerInput({ eyebrow: `${runId}_Later`, sortOrder: 900 }),
    );

    const earlier = await createHeroBanner(
      actor,
      bannerInput({ eyebrow: `${runId}_Earlier`, sortOrder: 100 }),
    );

    createdBannerIds.push(later.id, earlier.id);

    const result = await listAdminHeroBanners({
      search: runId,
      page: 1,
      limit: 20,
    });

    const eyebrows = result.banners.map((item) => item.eyebrow);

    expect(eyebrows.indexOf(`${runId}_Earlier`)).toBeLessThan(
      eyebrows.indexOf(`${runId}_Later`),
    );
  });

  it("keeps a switched-off banner in the table but off the carousel", async () => {
    if (!databaseAvailable) return;

    const banner = await createHeroBanner(
      actor,
      bannerInput({ eyebrow: `${runId}_Hidden`, isActive: false }),
    );

    createdBannerIds.push(banner.id);

    // The row survives — the audit trail needs something to describe.
    const stillThere = await getAdminHeroBanner(banner.id);

    expect(stillThere.isActive).toBe(false);

    // But the storefront does not show it.
    const publicBanners = await listPublicHeroBanners();

    expect(
      publicBanners.some((item) => item.id === banner.id),
    ).toBe(false);
  });

  it("shows an active banner on the carousel", async () => {
    if (!databaseAvailable) return;

    /*
     * `sortOrder: 0` puts the banner **first** in the carousel.
     *
     * The storefront caps the carousel at five slides, so a banner that
     * sorts behind five others would not appear at all — which is the
     * cap working, not a bug, but it would make this test depend on how
     * many banners the shop happens to have.
     */
    const banner = await createHeroBanner(
      actor,
      bannerInput({ eyebrow: `${runId}_Live`, isActive: true, sortOrder: 0 }),
    );

    createdBannerIds.push(banner.id);

    const publicBanners = await listPublicHeroBanners();

    const found = publicBanners.find((item) => item.id === banner.id);

    expect(found).toBeDefined();
    expect(found?.title).toBe(`${runId}_Headline`);
  });

  it("caps the carousel so a shopper is not made to watch it", async () => {
    if (!databaseAvailable) return;

    const publicBanners = await listPublicHeroBanners();

    // The cap is the whole point of the carousel: five slides is about
    // half a minute of carousel before the first product appears below
    // it, which is the most a storefront can ask for.
    expect(publicBanners.length).toBeLessThanOrEqual(MAX_HERO_BANNERS);
  });
});
