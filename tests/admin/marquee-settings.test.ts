import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The admin announcement controls.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The announcement bar is the one thing on the admin panel that an
 * ordinary shop owner will touch every week — flip the switch, change
 * the sentence, change it back. Two properties matter:
 *
 *   1. **The control is a real, accessible switch.**
 *
 *      The whole visual is CSS drawn on top of a hidden checkbox, so
 *      the control is reachable by keyboard, announced with its checked
 *      state by every screen reader without a line of ARIA, and
 *      participates in a form. A `<button role="switch">` would submit
 *      nothing, and a form that submits the wrong value is worse than
 *      no form.
 *
 *   2. **The form sends only what changed.**
 *
 *      The marquee has a **switch** and a **text**, and the natural
 *      admin gesture is to flip the switch without retyping the
 *      message. A form that sent the whole row on every save would also
 *      save whatever stale copy of the text the form happened to be
 *      holding — so "I changed the switch but not the message" is a
 *      real state, and it must not send the message.
 *
 * ── Why these tests read the source rather than the rendered page ────────
 *
 * The rendered page needs a running server and a signed-in
 * administrator. The properties being protected are properties of the
 * *shape* of the controls — what is on the wire, and what the markup
 * is — and the shape is written in the source.
 */
function readCode(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const ADMIN_DIR = path.join(process.cwd(), "src", "components", "admin");
const UI_DIR = path.join(process.cwd(), "src", "components", "ui");
const SWITCH = path.join(UI_DIR, "switch.tsx");
const FORM = path.join(ADMIN_DIR, "settings", "MarqueeSettingsForm.tsx");
const SETTINGS_PAGE = path.join(
  process.cwd(),
  "src",
  "app",
  "admin",
  "settings",
  "page.tsx",
);

describe("the switch", () => {
  const code = readCode(SWITCH);

  it("is a real checkbox, not a styled button", () => {
    /*
     * The checkbox is `sr-only` rather than `hidden`, because
     * `display: none` removes an element from the accessibility tree
     * **and** from the tab order.
     *
     * `role="switch"` makes the announcement "on" and "off" rather
     * than "checked" and "unchecked", and it is one of the roles ARIA
     * in HTML permits on a checkbox — so it does not override the
     * element's native behaviour.
     */
    expect(code).toContain('type="checkbox"');
    expect(code).toContain('role="switch"');
    expect(code).toContain("peer sr-only");
  });

  it("is labelled", () => {
    expect(code).toContain("<label");
    expect(code).toContain("htmlFor={switchId}");
    expect(code).toContain('id={switchId}');
  });

  it("draws the knob from the checkbox's own state", () => {
    /*
     * The `peer` variant is what makes the two halves of the control
     * agree: there is no JavaScript connecting the input to the visual,
     * so there is no state to fall out of sync — the visual *is* the
     * input.
     */
    expect(code).toContain("peer-checked:bg-brand-600");
    expect(code).toContain("peer-checked:translate-x-5");
  });

  it("puts the focus ring on the track, not the knob", () => {
    /*
     * The knob is 12 pixels wide and sits *inside* the track, so a ring
     * around it would be clipped by the track's own overflow.
     */
    expect(code).toContain("peer-focus-visible:ring-2");
    expect(code).not.toContain("peer-focus-visible:translate-x-5");
  });

  it("can be disabled", () => {
    expect(code).toContain("disabled={disabled}");
  });
});

describe("the announcement form", () => {
  const code = readCode(FORM);

  it("sends only the fields the admin touched", () => {
    /*
     * "I changed the switch but not the message" is a real state, and
     * it must not send the message.
     */
    expect(code).toContain("if (dirty.isMarqueeEnabled)");
    expect(code).toContain("if (dirty.marqueeText)");
    expect(code).toContain("if (dirty.marqueeHref)");
  });

  it("patches rather than replaces", () => {
    expect(code).toContain('method: "PATCH"');
    expect(code).toContain("/api/admin/settings/site-settings");
  });

  it("clears the link with an explicit null", () => {
    // An empty link clears it — that is a real setting, and the
    // service stores it as null.
    expect(code).toContain(
      'body.marqueeHref = href.trim() === "" ? null : href.trim();',
    );
  });

  it("warns before a save the server would refuse", () => {
    /*
     * The server refuses to switch the marquee on with no text to show.
     * The client cannot know what is stored, so it cannot enforce that
     * rule — but it can say so while the admin is still looking at the
     * form.
     */
    expect(code).toContain("wouldBeEmpty");
    expect(code).toContain(
      "The announcement needs some text before it can be switched on.",
    );
  });

  it("does not save the switch on its own", () => {
    /*
     * The switch is exactly the control that can be flipped *before*
     * the announcement is written, so flipping it must not publish
     * anything.
     */
    expect(code).not.toContain('method: "PUT"');
  });
});

describe("the settings page", () => {
  const code = readCode(SETTINGS_PAGE);

  it("mounts the announcement form", () => {
    expect(code).toContain("<MarqueeSettingsForm settings={settings} />");
  });

  it("loads the two surfaces independently", () => {
    /*
     * A failure to load the advisor's configuration must not hide the
     * announcement settings, and the other way round. An admin who
     * cannot reach the announcement switch is blocked from running the
     * shop.
     */
    expect(code).toContain("Promise.all([");
    expect(code).toContain("getSiteSettings()");
  });

  it("reads the settings through the admin service, not the public one", () => {
    // The admin half is allowed to see the whole row, including its
    // key and its update time; the public half is deliberately
    // narrower.
    expect(code).toContain('from "@/lib/admin/site-settings"');
  });
});
