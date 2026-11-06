import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { adminProfileUpdateSchema } from "@/lib/validation/admin";

/**
 * The administrator's own profile.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The profile form is the first admin surface that lets somebody edit
 * **themselves**. That makes it a different kind of surface from the
 * shop's settings, and it makes the boundaries around it the thing worth
 * testing:
 *
 *   1. The admin may change their **name** and their **phone number**.
 *   2. The admin may **not** change their **email address**, their
 *      **role**, or their **SMS consent** — and the reason each of those
 *      is excluded is a security decision, not a missing feature.
 *   3. The id the write applies to comes from the **session**, never
 *      from the request. A profile endpoint that took an id from the
 *      client would let any admin edit any other admin's row.
 *
 * The schema is what enforces (2) at the boundary: those fields are not
 * in the schema at all, so a request that names them is *refused* rather
 * than silently ignored.
 */
describe("the admin profile schema", () => {
  it("accepts a name", () => {
    const result = adminProfileUpdateSchema.safeParse({ name: "Ayesha Rahman" });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.name).toBe("Ayesha Rahman");
  });

  it("accepts a telephone number", () => {
    const result = adminProfileUpdateSchema.safeParse({ phone: "01819-000000" });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.phone).toBe("01819-000000");
  });

  it("accepts an empty telephone number, which clears it", () => {
    /*
     * "No number on file" is a real state and is different from "not
     * known". The form sends an empty string to mean it, and the
     * service stores it as null.
     */
    const result = adminProfileUpdateSchema.safeParse({ phone: "" });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.phone).toBe("");
  });

  it("accepts a body with neither field, which changes nothing", () => {
    /*
     * The route refuses an empty patch with a clear message rather than
     * writing a no-op. The schema itself is happy with it.
     */
    const result = adminProfileUpdateSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it("refuses a name that is only whitespace", () => {
    // A blank name in the top bar is not a name.
    const result = adminProfileUpdateSchema.safeParse({ name: "   " });

    expect(result.success).toBe(false);
  });

  it("refuses a name longer than the column", () => {
    const result = adminProfileUpdateSchema.safeParse({ name: "a".repeat(161) });

    expect(result.success).toBe(false);
  });

  it("refuses a telephone number longer than the column", () => {
    const result = adminProfileUpdateSchema.safeParse({ phone: "0".repeat(21) });

    expect(result.success).toBe(false);
  });

  it("refuses an email address", () => {
    /*
     * The email is the account's **identity** — the sign-in key and the
     * destination of every password reset. The shop owns an email
     * verification flow, so a self-service change would have to prove
     * the new address before it could be trusted. Until that is wired
     * up, the honest answer is to refuse the field rather than accept
     * it and skip the verification.
     */
    const result = adminProfileUpdateSchema.safeParse({
      email: "someone-else@example.com",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a role", () => {
    /*
     * A role change is a **privilege grant**, and a grant is somebody
     * else's decision — made on the Users page, by another
     * administrator, and recorded there. A self-service role field
     * would let any admin promote themselves.
     */
    const result = adminProfileUpdateSchema.safeParse({ role: "ADMIN" });

    expect(result.success).toBe(false);
  });

  it("refuses the SMS consent flag", () => {
    /*
     * `smsOptIn` is the only flag that authorises an SMS send, and it
     * is a decision about **being messaged** rather than about what
     * number to be messaged at. Editing it in the profile form would
     * let an admin quietly authorise messages to themselves without
     * going through the storefront's own consent flow.
     */
    const result = adminProfileUpdateSchema.safeParse({ smsOptIn: true });

    expect(result.success).toBe(false);
  });

  it("refuses a user id", () => {
    /*
     * The id is not in the schema because the id is not in the
     * **request** at all — it comes from the session. A schema that
     * accepted an id would be a schema that accepted an attacker-
     * controlled one.
     */
    const result = adminProfileUpdateSchema.safeParse({
      id: "somebody-else's-id",
      name: "Ayesha Rahman",
    });

    expect(result.success).toBe(false);
  });
});

/**
 * The profile service and its route.
 *
 * These read the source rather than the rendered page, because the
 * properties being protected are properties of the **shape** of the
 * write path — which id it applies to, and which fields it can reach.
 */
describe("the profile service", () => {
  const code = readCode(
    path.join(process.cwd(), "src", "lib", "admin", "profile.ts"),
  );

  it("takes the id from the actor, not from the patch", () => {
    /*
     * The only id that reaches the update is the actor's own. There is
     * no `patch.id`, and the `where` clause names `actor.id` — so a
     * malformed request cannot write to somebody else's row.
     */
    expect(code).toContain("where: { id: actor.id }");
    expect(code).not.toContain("patch.id");
  });

  it("selects only the columns the admin may see", () => {
    /*
     * The `passwordHash` is not selected. Excluding it here is
     * stronger than remembering to strip it later — so the select must
     * not name it.
     */
    expect(code).toContain("satisfies Prisma.UserSelect");
    expect(code).not.toContain("passwordHash: true");
  });

  it("writes the change and its audit entry in one transaction", () => {
    expect(code).toContain("db.$transaction");
    expect(code).toContain("writeAuditEntry(tx");
  });

  it("records the audit entry under its own action", () => {
    expect(code).toContain("ADMIN_PROFILE_ACTIONS.updated");
    expect(code).toContain('entityType: "admin_profile"');
  });

  it("records the phone number as a flag, not as the number", () => {
    /*
     * The audit log's own comment says never to store a phone number in
     * it. A number that *changed* is worth recording; the number itself
     * is not — the trail is browsable by every admin and is copied into
     * exports and backups.
     */
    expect(code).toContain('"set"');
    expect(code).not.toContain("after.phone = saved.phone;");
  });

  it("does not write an audit entry when nothing changed", () => {
    // A save that changed nothing is not an action worth auditing.
    expect(code).toContain("Object.keys(after).length > 0");
  });

  it("never writes the role or the SMS consent", () => {
    /*
     * The two are **read** — they are shown to the admin as read-only
     * facts — but they are never **written**. The check is on the write
     * itself: the update's `data` names only the two editable fields.
     */
    expect(code).toContain(
      "const data: Prisma.UserUpdateInput = {",
    );
    expect(code).not.toContain("role: patch");
    expect(code).not.toContain("smsOptIn: patch");
  });
});

/**
 * The profile route.
 */
describe("the profile route", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "app",
      "api",
      "admin",
      "settings",
      "profile",
      "route.ts",
    ),
  );

  it("is guarded by the admin guard", () => {
    expect(code).toContain("requireAdmin()");
  });

  it("takes the id from the session", () => {
    expect(code).toContain("admin.id");
  });

  it("refuses an empty patch", () => {
    expect(code).toContain("There is nothing to update.");
  });
});

/**
 * The profile form.
 */
describe("the profile form", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "components",
      "admin",
      "settings",
      "ProfileSettingsForm.tsx",
    ),
  );

  it("edits the name and the telephone number", () => {
    expect(code).toContain('id="profileName"');
    expect(code).toContain('id="profilePhone"');
  });

  it("sends only the fields the admin touched", () => {
    // The partial-update rule: correcting a typo in the name must not
    // blank the phone number the form happened to be holding.
    expect(code).toContain("if (dirty.name)");
    expect(code).toContain("if (dirty.phone)");
  });

  it("patches rather than replaces", () => {
    expect(code).toContain('method: "PATCH"');
    expect(code).toContain("/api/admin/settings/profile");
  });

  it("shows the email address as read-only rather than hiding it", () => {
    /*
     * An admin who cannot find the email field assumes the shop has
     * hidden it. One who sees it greyed out, with the reason, knows it
     * is fixed and why.
     */
    expect(code).toContain("profile.email");
    expect(code).not.toContain('id="profileEmail"');
  });

  it("shows the role as read-only", () => {
    expect(code).toContain("profile.role");
    expect(code).not.toContain('id="profileRole"');
  });
});

/**
 * The preferences form.
 */
describe("the preferences form", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "components",
      "admin",
      "settings",
      "PreferencesSettingsForm.tsx",
    ),
  );

  it("offers both themes", () => {
    expect(code).toContain("applyTheme");
    expect(code).toContain('aria-pressed={theme === "light"}');
    expect(code).toContain('aria-pressed={theme === "dark"}');
  });

  it("writes the sidebar preference through the shared store", () => {
    /*
     * The preferences form and the sidebar's own toggle have to write
     * through the **same** store, or the form would set a value the
     * sidebar never reads.
     */
    expect(code).toContain("writeAdminShellPrefs");
    expect(code).toContain("useAdminShellPrefs");
  });

  it("has no save button, because nothing needs saving", () => {
    /*
     * A card whose controls apply instantly and which nonetheless ends
     * with a "Save changes" button would teach the admin to expect a
     * step that is not there.
     */
    expect(code).not.toContain('type="submit"');
    expect(code).toContain("there is nothing to save");
  });
});

/**
 * The settings entry point in the admin header.
 */
describe("the account menu", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "components",
      "admin",
      "shell",
      "AdminProfileMenu.tsx",
    ),
  );

  it("links to the settings page", () => {
    expect(code).toContain('href="/admin/settings"');
  });

  it("links to the profile section of the settings page", () => {
    expect(code).toContain('href="/admin/settings#profile"');
  });

  it("closes on Escape", () => {
    expect(code).toContain('event.key === "Escape"');
  });

  it("closes on a click outside", () => {
    expect(code).toContain("mousedown");
  });

  it("offers the way out as well", () => {
    expect(code).toContain("LogoutButton");
  });

  it("marks the settings entry when the settings page is showing", () => {
    expect(code).toContain('aria-current={settingsActive ? "page" : undefined}');
  });
});

/**
 * Reads a source file with its comments stripped.
 */
function readCode(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}
