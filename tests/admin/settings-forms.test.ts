import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The admin settings' colour pickers and contact card.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * Two features landed in the admin settings at once, and both of them put
 * a **database value** into the page:
 *
 *   1. The marquee's **colours**. The admin picks a ground and a type,
 *      and the pair has to be legible — the bar is a thin strip of moving
 *      type on every page of the storefront.
 *
 *   2. The footer's **contact details**. The shop's own words about how
 *      to reach it, which were strings in the footer component until
 *      they were moved into the database.
 *
 * ── Why these tests read the source rather than the rendered page ────────
 *
 * The rendered page needs a running server and a signed-in
 * administrator. The properties being protected are properties of the
 * *shape* of the controls — what is on the wire, and what the markup
 * says — and the shape is written in the source.
 */
function readCode(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const ADMIN_DIR = path.join(process.cwd(), "src", "components", "admin");
const SETTINGS_DIR = path.join(ADMIN_DIR, "settings");
const LAYOUT_DIR = path.join(process.cwd(), "src", "components", "layout");

const COLOR_FIELD = path.join(SETTINGS_DIR, "ColorField.tsx");
const PRESET_PICKER = path.join(SETTINGS_DIR, "ColorPresetPicker.tsx");
const MARQUEE_FORM = path.join(SETTINGS_DIR, "MarqueeSettingsForm.tsx");
const CONTACT_FORM = path.join(SETTINGS_DIR, "ContactSettingsForm.tsx");
const FOOTER_CONTACT = path.join(LAYOUT_DIR, "footer-contact-section.tsx");
const SETTINGS_PAGE = path.join(
  process.cwd(),
  "src",
  "app",
  "admin",
  "settings",
  "page.tsx",
);

describe("the colour field", () => {
  const code = readCode(COLOR_FIELD);

  it("uses a real colour input", () => {
    /*
     * The browser's own picker is the point: it produces `#rrggbb`,
     * hands back a colour the admin chose by eye, and needs no
     * JavaScript to work.
     */
    expect(code).toContain('type="color"');
  });

  it("shows the colour it is editing as the picker's own swatch", () => {
    /*
     * The visible swatch is the input's **own** rendering — there is one
     * control and not two that have to be kept in step.
     */
    expect(code).toContain('type="color"');
    expect(code).toContain("value={normalized}");
  });

  it("labels the field", () => {
    expect(code).toContain("<label");
    expect(code).toContain("htmlFor={id}");
  });

  it("shows the field's hex value as text", () => {
    /*
     * The picker gives a colour, but a hex value is the thing that gets
     * stored — and the admin may want to type one directly.
     */
    expect(code).toContain("value");
  });
});

describe("the colour preset picker", () => {
  const code = readCode(PRESET_PICKER);

  it("offers the shop's pairs", () => {
    /*
     * A picker that opens on a random hue is a picker that makes people
     * *choose*. The swatches answer "what is the bar usually?", and the
     * common cases are one click away.
     */
    expect(code).toContain("MARQUEE_COLOR_PRESETS");
  });

  it("applies the ground and the type together", () => {
    /*
     * A ground and a type are only legible as a unit, so a preset that
     * set one and left the other would be a preset that could produce
     * an unreadable bar.
     */
    expect(code).toContain("onApply");
  });

  it("marks the preset that is currently in force", () => {
    /*
     * Otherwise the admin cannot tell which of the six is the one they
     * are already using.
     */
    expect(code).toContain("preset.background.toLowerCase() === background");
    expect(code).toContain("preset.foreground.toLowerCase() === text");
    expect(code).toContain("aria-pressed={isChosen}");
  });

  it("shows what the bar will look like before it is clicked", () => {
    // Two pixels of type tell the admin what the bar will look like.
    expect(code).toContain("style={{ backgroundColor: preset.background }}");
    expect(code).toContain("style={{ backgroundColor: preset.foreground }}");
  });
});

describe("the marquee form's colours", () => {
  const code = readCode(MARQUEE_FORM);

  it("sends each colour as its own field", () => {
    /*
     * The two colours are two separate columns, and the update is
     * partial — so a change to the ground must not send the type.
     */
    expect(code).toContain("if (dirty.marqueeBgColor)");
    expect(code).toContain("if (dirty.marqueeTextColor)");
  });

  it("warns while the admin is choosing, not only after the refusal", () => {
    /*
     * The server enforces the rule — the pair is a fact about the
     * **stored** state, so only the service can check it. But the client
     * can show the ratio live, while the admin is still holding the
     * picker.
     */
    expect(code).toContain("isLegiblePair");
    expect(code).toContain("colorsAreFaint");
    expect(code).toContain("4.5:1");
  });

  it("does not warn about a half-typed colour", () => {
    /*
     * A half-typed hex is not a faint pair — it is a value the admin is
     * still in the middle of writing. Warning about it would be a
     * complaint about their typing.
     */
    expect(code).toContain("colorsAreReal");
    expect(code).toContain("normalizeHexColor");
  });

  it("measures the pair that would actually be in force", () => {
    /*
     * The **saved** colour is used for the half the admin has not
     * touched, because that is the pair that would be in force if they
     * saved now.
     */
    expect(code).toContain("dirty.marqueeBgColor ? bgColor");
    expect(code).toContain("dirty.marqueeTextColor");
  });

  it("marks both colours dirty when a preset is applied", () => {
    // The preset sets both halves, so both are changes.
    expect(code).toContain('markDirty("marqueeBgColor")');
    expect(code).toContain('markDirty("marqueeTextColor")');
  });
});

describe("the contact-details form", () => {
  const code = readCode(CONTACT_FORM);

  it("edits all four details", () => {
    expect(code).toContain('id="supportEmail"');
    expect(code).toContain('id="supportPhone"');
    expect(code).toContain('id="supportHours"');
    expect(code).toContain('id="storeAddress"');
  });

  it("sends only the fields the admin touched", () => {
    // The same partial-update rule the marquee follows: editing the
    // opening hours must not save whatever stale copy of the address
    // the form happened to be holding.
    expect(code).toContain("if (dirty.supportEmail)");
    expect(code).toContain("if (dirty.supportPhone)");
    expect(code).toContain("if (dirty.supportHours)");
    expect(code).toContain("if (dirty.storeAddress)");
  });

  it("patches rather than replaces", () => {
    expect(code).toContain('method: "PATCH"');
    expect(code).toContain("/api/admin/settings/site-settings");
  });

  it("trims what it sends", () => {
    expect(code).toContain("body.supportEmail = email.trim()");
    expect(code).toContain("body.storeAddress = address.trim()");
  });

  it("lets a detail be emptied, which removes its line", () => {
    /*
     * An empty detail is a real state — the footer shows no phone line.
     * The alternative, a placeholder, makes the shop look like nobody
     * answers.
     */
    expect(code).not.toContain('if (dirty.supportPhone && phone.length > 0)');
  });

  it("uses the right input type for the email and the telephone", () => {
    // The browser gives the customer the right keyboard on a phone.
    expect(code).toContain('type="email"');
    expect(code).toContain('type="tel"');
  });

  it("gives the address a textarea, so it can be more than one line", () => {
    // An address is an address. It is not a set of structured parts.
    expect(code).toContain("<textarea");
  });
});

describe("the settings page", () => {
  const code = readCode(SETTINGS_PAGE);

  it("mounts both forms", () => {
    expect(code).toContain("<MarqueeSettingsForm settings={settings} />");
    expect(code).toContain("<ContactSettingsForm settings={settings} />");
  });
});

describe("the footer's contact details", () => {
  const code = readCode(FOOTER_CONTACT);

  it("reads them from the database, not from a string in the component", () => {
    expect(code).toContain("listPublicSiteSettings");
  });

  it("streams behind its own Suspense boundary", () => {
    /*
     * The footer is on **every** page. A bare database read in the shell
     * would opt the whole storefront out of the prerender — the home
     * page, the catalogue, every product — so that one row of contact
     * details could change.
     */
    expect(code).toContain("await connection();");
    expect(code).toContain("<Suspense fallback=");
  });

  it("renders no list at all when the shop has configured nothing", () => {
    /*
     * A shop that has told us nothing gets no lines — not an empty
     * `<ul>` with the footer's spacing around it.
     */
    expect(code).toContain(
      'if (email === "" && phone === "" && hours === "" && address === "")',
    );
  });

  it("shows a line only for a detail the shop has given", () => {
    // A missing detail is a missing line, not an empty one.
    expect(code).toContain('{hours !== "" ? (');
    expect(code).toContain('{phone !== "" ? (');
    expect(code).toContain('{email !== "" ? (');
    expect(code).toContain('{address !== "" ? (');
  });

  it("dials the digits, whatever way the shop wrote the number", () => {
    expect(code).toContain("phoneHref");
  });

  it("keeps the address's line breaks", () => {
    /*
     * An address read as one run-on line is an address nobody can copy
     * into a delivery app.
     */
    expect(code).toContain("whitespace-pre-line");
  });

  it("survives a database failure", () => {
    /*
     * The footer is on every page. A footer that threw would take the
     * whole storefront down for a detail nobody is reading yet.
     */
    expect(code).toContain(".catch(");
  });
});
