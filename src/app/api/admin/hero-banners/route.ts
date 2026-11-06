import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { created, ok } from "@/lib/api/respond";
import { toAuditActor } from "@/lib/admin/audit";
import {
  createHeroBanner,
  listAdminHeroBanners,
} from "@/lib/admin/hero-banners";
import { requireAdmin } from "@/lib/auth/guards";
import {
  adminHeroBannerQuerySchema,
  heroBannerCreateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/hero-banners
 *
 * The hero-banner list for the admin panel.
 *
 * Query parameters (all optional):
 *
 *   search    matches the banner's eyebrow, headline or body
 *   page      1-based page number
 *   limit     rows per page (max 100)
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = adminHeroBannerQuerySchema.parse(rawQuery);

    const result = await listAdminHeroBanners(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/admin/hero-banners
 *
 * Creates a homepage hero banner.
 *
 * Body:
 *
 *   {
 *     eyebrow: string,
 *     title: string,
 *     body: string,
 *     ctaLabel: string,
 *     ctaHref: string,
 *     secondaryCtaLabel: string,
 *     secondaryCtaHref: string,
 *     trust?: string[],
 *     image?: string | null,
 *     gradient?: string,
 *     glow?: string,
 *     isActive?: boolean,
 *     sortOrder?: number
 *   }
 *
 * `image` is a **storage key**, not a URL — the admin form uploads the
 * file to `/api/admin/hero-banners/images` first and sends the key it
 * gets back. Absent or `null` means "no artwork", and the storefront
 * falls back to the gradient wash alone.
 *
 * `ctaHref` and `secondaryCtaHref` must be **paths within the shop**.
 * A banner that links off-site is a banner that can send a customer
 * somewhere the shop does not control.
 *
 * The banner and its `HERO_BANNER_CREATED` audit entry are written in
 * **one** transaction.
 *
 * Admin only.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const body = heroBannerCreateSchema.parse(await request.json());

    const banner = await createHeroBanner(toAuditActor(admin), body);

    return created({ banner });
  } catch (error) {
    return handleApiError(error);
  }
}
