import { connection } from "next/server";

import { toAuditActor } from "@/lib/admin/audit";
import {
  getSiteSettings,
  updateSiteSettings,
} from "@/lib/admin/site-settings";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { normalizeHexColor } from "@/lib/format/colors";
import { siteSettingsUpdateSchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/settings/site-settings
 *
 * The Settings page's read.
 *
 * Returns the settings, or `null` when the row has never been created.
 * `null` is a meaningful answer — it means "nothing has been configured
 * yet" — and the Settings page shows the defaults in that case.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  // `connection()` MUST be called outside the try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    await requireAdmin();

    const settings = await getSiteSettings();

    return ok({ settings });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/settings/site-settings
 *
 * A **partial** update: every field is optional, and a field that is
 * absent is left exactly as it was.
 *
 * That matters here because the marquee has a **switch** and a
 * **text**. The natural admin gesture is to flip the switch without
 * retyping the message — so the client sends only what it changed, and
 * the service writes only what it was given. A form that PUT the whole
 * row would also save whatever stale copy of the text the form happened
 * to be holding.
 */
export async function PATCH(request: Request): Promise<Response> {
  await connection();

  try {
    const admin = await requireAdmin();

    const body: unknown = await request.json();
    const input = siteSettingsUpdateSchema.parse(body);

    // An empty patch would write nothing. Refusing it is better than
    // returning a 200 that appears to have done something.
    if (Object.keys(input).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

    const settings = await updateSiteSettings(toAuditActor(admin), {
      ...(input.isMarqueeEnabled !== undefined
        ? { isMarqueeEnabled: input.isMarqueeEnabled }
        : {}),
      ...(input.marqueeText !== undefined
        ? { marqueeText: input.marqueeText }
        : {}),
      ...(input.marqueeHref !== undefined
        ? { marqueeHref: input.marqueeHref }
        : {}),
      ...(input.marqueeBgColor !== undefined
        ? { marqueeBgColor: normalizeHexColor(input.marqueeBgColor) ?? input.marqueeBgColor }
        : {}),
      ...(input.marqueeTextColor !== undefined
        ? {
            marqueeTextColor:
              normalizeHexColor(input.marqueeTextColor) ??
              input.marqueeTextColor,
          }
        : {}),
      ...(input.supportEmail !== undefined
        ? { supportEmail: input.supportEmail }
        : {}),
      ...(input.supportPhone !== undefined
        ? { supportPhone: input.supportPhone }
        : {}),
      ...(input.supportHours !== undefined
        ? { supportHours: input.supportHours }
        : {}),
      ...(input.storeAddress !== undefined
        ? { storeAddress: input.storeAddress }
        : {}),
    });

    return ok({ settings });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
