import { describe, expect, it } from "vitest";

import {
  adminHeroBannerQuerySchema,
  heroBannerCreateSchema,
  heroBannerDeleteSchema,
  heroBannerUpdateSchema,
} from "@/lib/validation/admin";

/**
 * The homepage hero-banner validation.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * A hero banner is the shop's **opening line** — the words and the
 * artwork every customer reads first, and the two links they click
 * before anything else. Three properties matter:
 *
 *   1. **The links stay inside the shop.** A banner's call to action is
 *      rendered into an `href` on a `<Link>`. A banner that could point
 *      at `javascript:…`, at another host, or at a `data:` URI would be
 *      a way to take the storefront over from the shop that owns it. So
 *      the rule is closed: a path, and nothing else.
 *
 *   2. **The gradient and the glow are validated shapes, not free text.**
 *      Both are Tailwind class strings that end up in a `class`
 *      attribute, so a free-text field is a way to smuggle arbitrary
 *      styling into the storefront. They must *look like* a gradient
 *      utility and a background-colour utility, respectively.
 *
 *   3. **An update is partial.** A field the update does not name is
 *      left exactly as it was; an explicit `null` on the artwork clears
 *      it. The two are different intentions and the schema has to keep
 *      them apart.
 */

/**
 * A complete, valid banner body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eyebrow: "La Roche-Posay",
    title: "Derm-science for skin that reacts",
    body: "The French pharmacy range, authorised and stocked locally.",
    ctaLabel: "Shop La Roche-Posay",
    ctaHref: "/products?search=La%20Roche-Posay",
    secondaryCtaLabel: "Explore sunscreens",
    secondaryCtaHref: "/products?category=sunscreens",
    trust: ["Dermatologist tested", "Authenticity guaranteed"],
    gradient: "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]",
    glow: "bg-brand-400/45",
    isActive: true,
    sortOrder: 0,
    ...overrides,
  };
}

describe("heroBannerCreateSchema", () => {
  it("accepts a complete banner", () => {
    const parsed = heroBannerCreateSchema.parse(body());

    expect(parsed.title).toBe("Derm-science for skin that reacts");
    expect(parsed.trust).toEqual([
      "Dermatologist tested",
      "Authenticity guaranteed",
    ]);
    expect(parsed.isActive).toBe(true);
    expect(parsed.sortOrder).toBe(0);
  });

  it("defaults the trust points to an empty list", () => {
    const parsed = heroBannerCreateSchema.parse(
      body({ trust: undefined }),
    );

    expect(parsed.trust).toEqual([]);
  });

  it("requires an eyebrow, a headline and a supporting line", () => {
    expect(heroBannerCreateSchema.safeParse(body({ eyebrow: "" })).success).toBe(
      false,
    );
    expect(heroBannerCreateSchema.safeParse(body({ title: "" })).success).toBe(
      false,
    );
    expect(heroBannerCreateSchema.safeParse(body({ body: "" })).success).toBe(
      false,
    );
  });

  it("requires both buttons to carry a label and a link", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ ctaLabel: "" })).success,
    ).toBe(false);
    expect(
      heroBannerCreateSchema.safeParse(body({ ctaHref: "" })).success,
    ).toBe(false);
    expect(
      heroBannerCreateSchema.safeParse(body({ secondaryCtaLabel: "" })).success,
    ).toBe(false);
    expect(
      heroBannerCreateSchema.safeParse(body({ secondaryCtaHref: "" })).success,
    ).toBe(false);
  });

  it("caps the trust points at four", () => {
    const five = ["a", "b", "c", "d", "e"];

    expect(
      heroBannerCreateSchema.safeParse(body({ trust: five })).success,
    ).toBe(false);

    expect(
      heroBannerCreateSchema.safeParse(body({ trust: ["a", "b", "c", "d"] }))
        .success,
    ).toBe(true);
  });

  it("refuses a negative order", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ sortOrder: -1 })).success,
    ).toBe(false);
  });

  it("refuses a fractional order", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ sortOrder: 1.5 })).success,
    ).toBe(false);
  });
});

describe("heroBannerCreateSchema — the links stay inside the shop", () => {
  it("accepts a path", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ ctaHref: "/products" })).success,
    ).toBe(true);
  });

  it("refuses an absolute URL", () => {
    expect(
      heroBannerCreateSchema.safeParse(
        body({ ctaHref: "https://evil.example/steal" }),
      ).success,
    ).toBe(false);
  });

  it("refuses a protocol-relative URL", () => {
    // "//evil.example" resolves to another host exactly the way an
    // absolute URL does, so it is refused for the same reason.
    expect(
      heroBannerCreateSchema.safeParse(
        body({ ctaHref: "//evil.example/steal" }),
      ).success,
    ).toBe(false);
  });

  it("refuses a javascript: URL", () => {
    expect(
      heroBannerCreateSchema.safeParse(
        body({ ctaHref: "javascript:alert(1)" }),
      ).success,
    ).toBe(false);
  });

  it("refuses a relative path", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ ctaHref: "products" })).success,
    ).toBe(false);
  });

  it("applies the same rule to the second button", () => {
    expect(
      heroBannerCreateSchema.safeParse(
        body({ secondaryCtaHref: "https://evil.example" }),
      ).success,
    ).toBe(false);
  });
});

describe("heroBannerCreateSchema — the gradient and the glow", () => {
  it("accepts a linear-gradient utility", () => {
    expect(
      heroBannerCreateSchema.safeParse(
        body({
          gradient:
            "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]",
        }),
      ).success,
    ).toBe(true);
  });

  it("refuses a class string that is not a gradient", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ gradient: "bg-red-500" }))
        .success,
    ).toBe(false);
  });

  it("refuses a gradient with a second utility smuggled in", () => {
    expect(
      heroBannerCreateSchema.safeParse(
        body({
          gradient:
            "bg-[linear-gradient(135deg,#fff_0%,#000_100%)] bg-[url(https://evil.example/x)]",
        }),
      ).success,
    ).toBe(false);
  });

  it("refuses free text", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ gradient: "red" })).success,
    ).toBe(false);
  });

  it("accepts a background-colour utility for the glow", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ glow: "bg-brand-400/45" }))
        .success,
    ).toBe(true);
  });

  it("refuses a glow that is not a background colour", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ glow: "text-red-500" })).success,
    ).toBe(false);
  });
});

describe("heroBannerCreateSchema — there is no showcase source", () => {
  /*
   * The hero used to carry a **showcase source**: a brand or a category
   * whose products were resolved into a plate of floating product cards
   * beside the copy.
   *
   * That plate is gone. The hero is a poster now — the words, a
   * gradient wash and an optional photograph — and a banner that could
   * still ask for a product column would be a way to put the clutter
   * straight back.
   *
   * So the fields are not merely ignored. They are **rejected**: a
   * body that carries a showcase source is not a valid banner, and the
   * admin cannot silently set one.
   */
  it("refuses a brand", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ showcaseBrand: "CeraVe" }))
        .success,
    ).toBe(false);
  });

  it("refuses a category", () => {
    expect(
      heroBannerCreateSchema.safeParse(body({ showcaseCategory: "sunscreens" }))
        .success,
    ).toBe(false);
  });

  it("keeps no showcase field on the parsed banner", () => {
    const parsed = heroBannerCreateSchema.parse(body());

    expect(parsed).not.toHaveProperty("showcaseBrand");
    expect(parsed).not.toHaveProperty("showcaseCategory");
  });
});

describe("heroBannerUpdateSchema", () => {
  it("leaves every field alone when the body is empty", () => {
    const parsed = heroBannerUpdateSchema.parse({});

    expect(Object.keys(parsed)).toHaveLength(0);
  });

  it("changes only the field it names", () => {
    const parsed = heroBannerUpdateSchema.parse({ title: "New headline" });

    expect(parsed.title).toBe("New headline");
    expect(parsed.eyebrow).toBeUndefined();
    expect(parsed.isActive).toBeUndefined();
  });

  it("accepts an explicit null for the artwork, which clears it", () => {
    const parsed = heroBannerUpdateSchema.parse({ image: null });

    expect(parsed.image).toBeNull();
  });

  it("refuses an explicit null for a field that has no null", () => {
    expect(
      heroBannerUpdateSchema.safeParse({ title: null }).success,
    ).toBe(false);
    expect(
      heroBannerUpdateSchema.safeParse({ isActive: null }).success,
    ).toBe(false);
  });

  it("keeps the link rule", () => {
    expect(
      heroBannerUpdateSchema.safeParse({ ctaHref: "https://evil.example" })
        .success,
    ).toBe(false);
  });

  it("refuses a showcase source, so the clutter cannot be re-added", () => {
    expect(
      heroBannerUpdateSchema.safeParse({ showcaseBrand: "CeraVe" }).success,
    ).toBe(false);
    expect(
      heroBannerUpdateSchema.safeParse({ showcaseCategory: "sunscreens" })
        .success,
    ).toBe(false);
  });
});

describe("heroBannerDeleteSchema", () => {
  it("requires a reason", () => {
    expect(heroBannerDeleteSchema.safeParse({ reason: "" }).success).toBe(
      false,
    );
    expect(
      heroBannerDeleteSchema.safeParse({ reason: "   " }).success,
    ).toBe(false);
  });

  it("accepts a reason", () => {
    expect(
      heroBannerDeleteSchema.safeParse({ reason: "The campaign ended." })
        .success,
    ).toBe(true);
  });
});

describe("adminHeroBannerQuerySchema", () => {
  it("accepts an empty query", () => {
    const parsed = adminHeroBannerQuerySchema.parse({});

    expect(parsed.page).toBe(1);
    expect(parsed.search).toBeUndefined();
  });

  it("accepts a search term and a page", () => {
    const parsed = adminHeroBannerQuerySchema.parse({
      search: "sunscreen",
      page: "3",
    });

    expect(parsed.search).toBe("sunscreen");
    expect(parsed.page).toBe(3);
  });

  it("refuses a page that is not a number", () => {
    expect(
      adminHeroBannerQuerySchema.safeParse({ page: "three" }).success,
    ).toBe(false);
  });
});
