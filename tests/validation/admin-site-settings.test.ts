import { describe, expect, it } from "vitest";

import { siteSettingsUpdateSchema } from "@/lib/validation/admin";

/**
 * The announcement-marquee validation.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The marquee is the shop's **first sentence** — the one line of copy
 * the shop publishes on every page without being asked. Three
 * properties matter:
 *
 *   1. **The link stays inside the shop.** The marquee's destination is
 *      rendered into an `href` on a `<Link>` that appears on **every**
 *      page. A marquee that could point at `javascript:…`, at another
 *      host, or at a `data:` URI would be a way to take the storefront
 *      over from the shop that owns it. So the rule is closed: a path,
 *      and nothing else.
 *
 *   2. **An update is partial.** A field the update does not name is
 *      left exactly as it was. This matters more here than it might
 *      seem: the marquee has a **switch** and a **text**, and the
 *      natural admin gesture is to flip the switch without retyping the
 *      message. A whole-row save would also save whatever stale copy of
 *      the text the form happened to be holding.
 *
 *   3. **The text is bounded.** A marquee is one scrolling line. Two
 *      hundred and forty characters is roughly two full passes of a wide
 *      desktop — enough for a sentence and not enough for a paragraph.
 *
 * The rule that "switching the marquee on requires text to show" is
 * **not** here, and that is deliberate: it is a rule about the *stored*
 * state, because a request that switches the marquee on without naming
 * the text is switching on whatever is already saved — and only the
 * service can see what that is. The schema enforces the shape; the
 * service enforces the rule.
 */
describe("siteSettingsUpdateSchema", () => {
  it("leaves every field alone when the body is empty", () => {
    const parsed = siteSettingsUpdateSchema.parse({});

    expect(Object.keys(parsed)).toHaveLength(0);
  });

  it("changes only the field it names", () => {
    const parsed = siteSettingsUpdateSchema.parse({ isMarqueeEnabled: true });

    expect(parsed.isMarqueeEnabled).toBe(true);
    expect(parsed.marqueeText).toBeUndefined();
    expect(parsed.marqueeHref).toBeUndefined();
  });

  it("accepts the switch on its own", () => {
    const parsed = siteSettingsUpdateSchema.parse({ isMarqueeEnabled: false });

    expect(parsed.isMarqueeEnabled).toBe(false);
  });

  it("refuses a switch that is not a boolean", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ isMarqueeEnabled: "yes" }).success,
    ).toBe(false);

    expect(
      siteSettingsUpdateSchema.safeParse({ isMarqueeEnabled: 1 }).success,
    ).toBe(false);
  });

  it("trims the message", () => {
    const parsed = siteSettingsUpdateSchema.parse({
      marqueeText: "  Complimentary delivery this weekend.  ",
    });

    expect(parsed.marqueeText).toBe("Complimentary delivery this weekend.");
  });

  it("refuses an empty message", () => {
    /*
     * An empty message is not a way to clear the announcement — the
     * switch is. Clearing the text by sending an empty string would
     * leave the marquee switched on with nothing to say, which is the
     * one state the storefront refuses to render.
     */
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeText: "" }).success,
    ).toBe(false);

    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeText: "   " }).success,
    ).toBe(false);
  });

  it("caps the message at 240 characters", () => {
    const long = "a".repeat(240);

    expect(siteSettingsUpdateSchema.safeParse({ marqueeText: long }).success).toBe(
      true,
    );

    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeText: `${long}a` }).success,
    ).toBe(false);
  });

  it("accepts an explicit null for the link, which clears it", () => {
    const parsed = siteSettingsUpdateSchema.parse({ marqueeHref: null });

    expect(parsed.marqueeHref).toBeNull();
  });

  it("refuses an empty link, which is not the same as a cleared one", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeHref: "" }).success,
    ).toBe(false);

    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeHref: "   " }).success,
    ).toBe(false);
  });
});

describe("siteSettingsUpdateSchema — the link stays inside the shop", () => {
  it("accepts a path", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeHref: "/category/skincare" })
        .success,
    ).toBe(true);
  });

  it("accepts a path with a query string", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({
        marqueeHref: "/products?category=sunscreens",
      }).success,
    ).toBe(true);
  });

  it("refuses an absolute URL", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({
        marqueeHref: "https://evil.example/steal",
      }).success,
    ).toBe(false);
  });

  it("refuses a protocol-relative URL", () => {
    // "//evil.example" resolves to another host exactly the way an
    // absolute URL does, so it is refused for the same reason.
    expect(
      siteSettingsUpdateSchema.safeParse({
        marqueeHref: "//evil.example/steal",
      }).success,
    ).toBe(false);
  });

  it("refuses a javascript: URL", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({
        marqueeHref: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("refuses a relative path", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeHref: "category/skincare" })
        .success,
    ).toBe(false);
  });

  it("caps the link at 255 characters", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeHref: `/${"a".repeat(255)}` })
        .success,
    ).toBe(false);
  });
});

/**
 * The colours and the contact details.
 *
 * The colours are two hex triplets the admin picks, and they are rendered
 * **inline** into a `style` attribute — so the schema's job is to make
 * sure only a colour can reach that attribute. The **legibility** of the
 * pair is a rule about the stored state, so it lives in the service
 * rather than here: a request that changes only the ground changes the
 * pair, and only the service can see what the type already is.
 */
describe("siteSettingsUpdateSchema — the colours", () => {
  it("accepts a six-digit hex colour", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeBgColor: "#1c1917" }).success,
    ).toBe(true);

    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeTextColor: "#ffffff" }).success,
    ).toBe(true);
  });

  it("accepts the three-digit form, which a human types", () => {
    // Refusing it would be pedantry. The expansion to six digits happens
    // in the service, so the database holds one canonical spelling.
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeBgColor: "#fff" }).success,
    ).toBe(true);
  });

  it("accepts an uppercase colour", () => {
    // A human typing "#BE185D" has given a perfectly good colour, and
    // the schema and the normaliser have to agree on that — otherwise
    // the schema would accept a value the normaliser threw away, and
    // the admin would silently get the default colour.
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeBgColor: "#BE185D" }).success,
    ).toBe(true);
  });

  it("refuses a value that is not a colour", () => {
    // These are the values that must never reach a `style` attribute.
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeBgColor: "red" }).success,
    ).toBe(false);

    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeBgColor: "#12345" }).success,
    ).toBe(false);

    expect(
      siteSettingsUpdateSchema.safeParse({
        marqueeTextColor: "url(javascript:alert(1))",
      }).success,
    ).toBe(false);

    expect(
      siteSettingsUpdateSchema.safeParse({
        marqueeBgColor: "#1c1917; background: url(x)",
      }).success,
    ).toBe(false);
  });

  it("refuses a colour without its hash", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ marqueeBgColor: "1c1917" }).success,
    ).toBe(false);
  });
});

describe("siteSettingsUpdateSchema — the contact details", () => {
  it("accepts an email address", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({
        supportEmail: "hello@euroglam.bd",
      }).success,
    ).toBe(true);
  });

  it("accepts an empty email, which means the footer shows no email line", () => {
    /*
     * The shared email schema's first rule is that an email is
     * required, and that is exactly the rule that does not apply here.
     */
    expect(
      siteSettingsUpdateSchema.safeParse({ supportEmail: "" }).success,
    ).toBe(true);
  });

  it("refuses a value that is not an email address", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ supportEmail: "not an email" })
        .success,
    ).toBe(false);
  });

  it("accepts a phone number in the way the shop writes it", () => {
    // The number is a **display** string; the `tel:` href is built from
    // the digits, so the shape is the country's business rather than the
    // validation layer's.
    expect(
      siteSettingsUpdateSchema.safeParse({ supportPhone: "+880 1819-000000" })
        .success,
    ).toBe(true);

    expect(
      siteSettingsUpdateSchema.safeParse({ supportPhone: "01819-000000" })
        .success,
    ).toBe(true);
  });

  it("accepts empty hours and an empty address", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({ supportHours: "" }).success,
    ).toBe(true);

    expect(
      siteSettingsUpdateSchema.safeParse({ storeAddress: "" }).success,
    ).toBe(true);
  });

  it("accepts an address across several lines", () => {
    // An address is an address. It is not a set of structured parts that
    // every shop fills in the same way.
    const parsed = siteSettingsUpdateSchema.parse({
      storeAddress: "House 12, Road 5, Dhanmondi\nDhaka 1209",
    });

    expect(parsed.storeAddress).toContain("\n");
  });

  it("caps the address, the hours and the phone", () => {
    expect(
      siteSettingsUpdateSchema.safeParse({
        storeAddress: "a".repeat(401),
      }).success,
    ).toBe(false);

    expect(
      siteSettingsUpdateSchema.safeParse({ supportHours: "a".repeat(121) })
        .success,
    ).toBe(false);

    expect(
      siteSettingsUpdateSchema.safeParse({ supportPhone: "a".repeat(41) })
        .success,
    ).toBe(false);
  });
});
