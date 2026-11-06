import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CUSTOMER_PROFILE_FORBIDDEN_KEYS,
  customerPasswordChangeSchema,
  customerProfileUpdateSchema,
  savedAddressSchema,
} from "@/lib/validation/account";

/**
 * The customer's own account settings.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * This is the first storefront surface that lets somebody edit
 * **themselves**. That makes it a different kind of surface from the
 * shop's settings, and it makes the boundaries around it the thing worth
 * testing:
 *
 *   1. The customer may change their **name**, their **phone number**
 *      and their **saved delivery address**.
 *   2. The customer may change their **password**, but only by quoting
 *      the current one.
 *   3. The customer may **not** change their **email address**, their
 *      **role**, their **SMS consent**, or anything else the schema
 *      refuses — and the reason each of those is excluded is a security
 *      decision, not a missing feature.
 *   4. The id the write applies to comes from the **session**, never
 *      from the request. A profile endpoint that took an id from the
 *      client would let any customer edit any other customer's row.
 *
 * The schema is what enforces (3) at the boundary: those fields are not
 * in the schema at all, so a request that names them is *refused* rather
 * than silently ignored.
 */
describe("the customer profile schema", () => {
  it("accepts a name", () => {
    const result = customerProfileUpdateSchema.safeParse({
      name: "Ayesha Rahman",
    });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.name).toBe("Ayesha Rahman");
  });

  it("accepts a telephone number and normalises it", () => {
    const result = customerProfileUpdateSchema.safeParse({
      phone: "01712345678",
    });

    expect(result.success).toBe(true);

    if (!result.success) return;

    // The E.164 form, so the same number cannot be stored twice.
    expect(result.data.phone).toBe("+8801712345678");
  });

  it("accepts an empty telephone number, which clears it", () => {
    /*
     * "No number on file" is a real state and is different from "not
     * known". The form sends an empty string to mean it, and the
     * service stores it as null.
     */
    const result = customerProfileUpdateSchema.safeParse({ phone: "" });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.phone).toBe("");
  });

  it("accepts a body with no fields, which changes nothing", () => {
    /*
     * The route refuses an empty patch with a clear message rather than
     * writing a no-op. The schema itself is happy with it.
     */
    const result = customerProfileUpdateSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it("refuses a name that is only whitespace", () => {
    // A blank name on an order is not a name.
    const result = customerProfileUpdateSchema.safeParse({ name: "   " });

    expect(result.success).toBe(false);
  });

  it("refuses a name longer than the column", () => {
    const result = customerProfileUpdateSchema.safeParse({
      name: "a".repeat(161),
    });

    expect(result.success).toBe(false);
  });

  it("refuses a telephone number that is not a mobile number", () => {
    const result = customerProfileUpdateSchema.safeParse({
      phone: "12345",
    });

    expect(result.success).toBe(false);
  });

  it("refuses an email address", () => {
    /*
     * The email is the account's **identity** — the sign-in key and the
     * destination of every order confirmation and password reset. The
     * shop owns an email verification flow, so a self-service change
     * would have to prove the new address before it could be trusted.
     * Until that is wired up, the honest answer is to refuse the field
     * rather than accept it and skip the verification.
     */
    const result = customerProfileUpdateSchema.safeParse({
      email: "someone-else@example.com",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a role", () => {
    /*
     * A role change is a **privilege grant**, and a grant is somebody
     * else's decision. A self-service role field would let any customer
     * promote themselves to an administrator.
     */
    const result = customerProfileUpdateSchema.safeParse({ role: "ADMIN" });

    expect(result.success).toBe(false);
  });

  it("refuses the SMS consent flag", () => {
    /*
     * `smsOptIn` is the only flag that authorises an SMS send, and it
     * is a decision about **being messaged** rather than about what
     * number to be messaged at. Editing it in the profile form would
     * let a customer quietly authorise messages to themselves without
     * going through the storefront's own consent flow.
     */
    const result = customerProfileUpdateSchema.safeParse({
      smsOptIn: true,
    });

    expect(result.success).toBe(false);
  });

  it("refuses a password hash", () => {
    /*
     * The password is changed through its own route, which asks for the
     * current password first. A body that carried a `passwordHash` would
     * be a request to set a hash directly, and nothing in the system
     * should be able to do that.
     */
    const result = customerProfileUpdateSchema.safeParse({
      passwordHash: "$2a$12$whatever",
    });

    expect(result.success).toBe(false);
  });

  it("refuses an email verification timestamp", () => {
    /*
     * An unverified account is an account whose address nobody has
     * proved. The customer cannot tick that box themselves.
     */
    const result = customerProfileUpdateSchema.safeParse({
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a user id", () => {
    /*
     * The id is not in the schema because the id is not in the
     * **request** at all — it comes from the session. A schema that
     * accepted an id would be a schema that accepted an attacker-
     * controlled one.
     */
    const result = customerProfileUpdateSchema.safeParse({
      id: "somebody-else's-id",
      name: "Ayesha Rahman",
    });

    expect(result.success).toBe(false);
  });

  it("refuses every forbidden key", () => {
    /*
     * A loop rather than a handful of cases, so a key added to the
     * forbidden list without a matching test cannot slip through.
     */
    for (const key of CUSTOMER_PROFILE_FORBIDDEN_KEYS) {
      const result = customerProfileUpdateSchema.safeParse({
        [key]: "anything",
      });

      expect(result.success, `the "${key}" key must be refused`).toBe(false);
    }
  });
});

/**
 * The saved delivery address.
 */
describe("the saved address schema", () => {
  const valid = {
    fullName: "Ayesha Rahman",
    phone: "01712345678",
    addressLine1: "House 12, Road 5, Block C",
    city: "Dhaka",
    district: "Dhaka",
    postalCode: "1207",
  };

  it("accepts a complete address", () => {
    const result = savedAddressSchema.safeParse(valid);

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.fullName).toBe("Ayesha Rahman");
    expect(result.data.postalCode).toBe("1207");
  });

  it("defaults to being the default address", () => {
    const result = savedAddressSchema.safeParse(valid);

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.isDefault).toBe(true);
  });

  it("accepts an apartment or landmark line", () => {
    const result = savedAddressSchema.safeParse({
      ...valid,
      addressLine2: "Flat 3B, beside the pharmacy",
    });

    expect(result.success).toBe(true);
  });

  it("refuses a missing street address", () => {
    const { addressLine1: _omitted, ...rest } = valid;

    void _omitted;

    const result = savedAddressSchema.safeParse(rest);

    expect(result.success).toBe(false);
  });

  it("refuses a postal code that is not four digits", () => {
    const result = savedAddressSchema.safeParse({
      ...valid,
      postalCode: "12",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a phone number that is not a mobile number", () => {
    const result = savedAddressSchema.safeParse({
      ...valid,
      phone: "12345",
    });

    expect(result.success).toBe(false);
  });

  it("refuses delivery notes", () => {
    /*
     * A delivery note belongs to a particular delivery ("please call
     * before arriving"), not to a home address that will be reused for
     * years. The note is part of the **order**, not the address.
     */
    const result = savedAddressSchema.safeParse({
      ...valid,
      notes: "Please call before arriving.",
    });

    expect(result.success).toBe(false);
  });

  it("is accepted as part of a profile update", () => {
    const result = customerProfileUpdateSchema.safeParse({
      address: valid,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a null address, which clears it", () => {
    const result = customerProfileUpdateSchema.safeParse({
      address: null,
    });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.address).toBeNull();
  });
});

/**
 * The password change.
 */
describe("the password change schema", () => {
  it("accepts a well-formed change", () => {
    const result = customerPasswordChangeSchema.safeParse({
      currentPassword: "the old one",
      newPassword: "a much longer passphrase",
      confirmPassword: "a much longer passphrase",
    });

    expect(result.success).toBe(true);
  });

  it("refuses a change with no current password", () => {
    /*
     * The current password is the proof that the person making the
     * request is the person who owns the account. Without it, anybody
     * who walks up to an unlocked device could change the password and
     * lock the real owner out.
     */
    const result = customerPasswordChangeSchema.safeParse({
      currentPassword: "",
      newPassword: "a much longer passphrase",
      confirmPassword: "a much longer passphrase",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a new password that is too short", () => {
    const result = customerPasswordChangeSchema.safeParse({
      currentPassword: "the old one",
      newPassword: "short",
      confirmPassword: "short",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a confirmation that does not match", () => {
    const result = customerPasswordChangeSchema.safeParse({
      currentPassword: "the old one",
      newPassword: "a much longer passphrase",
      confirmPassword: "a different passphrase",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a new password equal to the current one", () => {
    /*
     * The comparison is on the **plaintext** — two bcrypt hashes of the
     * same password are different strings, so comparing hashes would
     * never match and the rule would be dead code that looked alive.
     */
    const result = customerPasswordChangeSchema.safeParse({
      currentPassword: "the same passphrase",
      newPassword: "the same passphrase",
      confirmPassword: "the same passphrase",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a user id", () => {
    const result = customerPasswordChangeSchema.safeParse({
      currentPassword: "the old one",
      newPassword: "a much longer passphrase",
      confirmPassword: "a much longer passphrase",
      id: "somebody-else's-id",
    });

    expect(result.success).toBe(false);
  });
});

/**
 * The customer profile service.
 *
 * These read the source rather than the rendered page, because the
 * properties being protected are properties of the **shape** of the
 * write path — which id it applies to, and which fields it can reach.
 */
describe("the customer profile service", () => {
  const code = readCode(
    path.join(process.cwd(), "src", "lib", "account", "profile.ts"),
  );

  it("takes the id from the caller, not from the patch", () => {
    /*
     * The only id that reaches the update is the caller's own. There is
     * no `patch.id`, and the `where` clause names the caller's id — so
     * a malformed request cannot write to somebody else's row.
     */
    expect(code).toContain("where: { id: customerId }");
    expect(code).not.toContain("patch.id");
  });

  it("selects only the columns the customer may see", () => {
    /*
     * The `passwordHash` is not in the **profile** select. Excluding it
     * there is stronger than remembering to strip it later — so the
     * profile select must not name it.
     *
     * The password *change* path does read the hash, because it has to
     * verify the current password against it. So the check is scoped to
     * the profile select rather than to the whole file.
     */
    expect(code).toContain("satisfies Prisma.UserSelect");

    const profileSelect = code.slice(
      code.indexOf("CUSTOMER_PROFILE_SELECT"),
      code.indexOf("CUSTOMER_PROFILE_SELECT") + 600,
    );

    expect(profileSelect).not.toContain("passwordHash");
  });

  it("never writes the role or the SMS consent", () => {
    /*
     * The two are **read** — they are shown to the customer as read-only
     * facts — but they are never **written**. The check is on the write
     * itself: the update's `data` names only the three editable fields.
     */
    expect(code).toContain("const data: Prisma.UserUpdateInput = {");
    expect(code).not.toContain("role: patch");
    expect(code).not.toContain("smsOptIn: patch");
  });

  it("verifies the current password against the stored hash", () => {
    /*
     * The check is a real cryptographic verification, not a string
     * comparison — a comparison against a hash the client cannot see
     * would never match anyway.
     */
    expect(code).toContain("verifyPassword(currentPassword, user.passwordHash)");
  });

  it("hashes the new password rather than storing it", () => {
    expect(code).toContain("hashPassword(newPassword)");
    expect(code).not.toContain("passwordHash: newPassword");
  });

  it("does not sign the customer out of the device they are on", () => {
    /*
     * The customer is already signed in on the device they are using,
     * and changing their own password is a deliberate act. Signing them
     * out of the very screen they are using would be an odd reward for
     * a security action.
     */
    expect(code).not.toContain("deleteSession");
    expect(code).not.toContain("clearSession");
  });

  it("writes no admin audit entry", () => {
    /*
     * The admin audit trail answers "what did an administrator do?".
     * A customer editing their own name is not an administrator action,
     * and recording every customer's keystroke in a log every admin can
     * browse would be a privacy problem, not a feature.
     */
    expect(code).not.toContain("writeAuditEntry");
    expect(code).not.toContain("AdminAuditLog");
  });
});

/**
 * The profile route.
 */
describe("the customer profile route", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "app",
      "api",
      "account",
      "profile",
      "route.ts",
    ),
  );

  it("is guarded by the customer guard", () => {
    expect(code).toContain("requireCustomer()");
  });

  it("takes the id from the session", () => {
    expect(code).toContain("customer.id");
  });

  it("refuses an empty patch", () => {
    expect(code).toContain("There is nothing to update.");
  });

  it("patches rather than replaces", () => {
    /*
     * The patch is built from named fields only, so a field the client
     * did not send cannot be blanked by a field it did.
     */
    expect(code).toContain("input.name !== undefined");
    expect(code).toContain("input.phone !== undefined");
    expect(code).toContain("input.address !== undefined");
  });
});

/**
 * The password route.
 */
describe("the customer password route", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "app",
      "api",
      "account",
      "password",
      "route.ts",
    ),
  );

  it("is guarded by the customer guard", () => {
    expect(code).toContain("requireCustomer()");
  });

  it("is a POST, not a patch on the profile", () => {
    /*
     * A password change is not a partial update of the profile — it is
     * an action with its own preconditions and its own failure mode.
     */
    expect(code).toContain("export async function POST");
    expect(code).not.toContain("export async function PATCH");
  });

  it("takes the id from the session", () => {
    expect(code).toContain("customer.id");
  });
});

/**
 * The settings page.
 */
describe("the account settings page", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "app",
      "(storefront)",
      "account",
      "settings",
      "page.tsx",
    ),
  );

  it("is allowed to block, because it belongs to a user", () => {
    expect(code).toContain("export const instant = false");
  });

  it("reads the session", () => {
    expect(code).toContain("getOptionalUser()");
  });

  it("shows the personal details, the address and the password", () => {
    expect(code).toContain("PersonalDetailsForm");
    expect(code).toContain("AddressForm");
    expect(code).toContain("PasswordForm");
  });

  it("does not load the password hash", () => {
    expect(code).not.toContain("passwordHash");
  });
});

/**
 * The personal details form.
 */
describe("the personal details form", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "components",
      "account",
      "account-settings-forms.tsx",
    ),
  );

  it("edits the name and the telephone number", () => {
    expect(code).toContain('id="profileName"');
    expect(code).toContain('id="profilePhone"');
  });

  it("sends only the fields the customer touched", () => {
    /*
     * The partial-update rule: correcting a typo in the name must not
     * blank the phone number the form happened to be holding.
     */
    expect(code).toContain("const dirty = {");
  });

  it("patches rather than replaces", () => {
    expect(code).toContain('method: "PATCH"');
    expect(code).toContain("/api/account/profile");
  });

  it("shows the email address as read-only rather than hiding it", () => {
    /*
     * A customer who cannot find the email field assumes the shop has
     * hidden it. One who sees it greyed out, with the reason, knows it
     * is fixed and why.
     */
    expect(code).toContain("details.email");
    expect(code).not.toContain('id="profileEmail"');
  });

  it("shows the SMS consent as read-only", () => {
    expect(code).toContain("details.smsOptIn");
  });
});

/**
 * The address form.
 */
describe("the address form", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "components",
      "account",
      "address-form.tsx",
    ),
  );

  it("edits every field of the address", () => {
    expect(code).toContain('id="addressFullName"');
    expect(code).toContain('id="addressPhone"');
    expect(code).toContain('id="addressLine1"');
    expect(code).toContain('id="addressCity"');
    expect(code).toContain('id="addressDistrict"');
    expect(code).toContain('id="addressPostalCode"');
  });

  it("sends the address as a single patch field", () => {
    expect(code).toContain('method: "PATCH"');
    expect(code).toContain("/api/account/profile");
    expect(code).toContain("address: {");
  });

  it("marks the address as the default", () => {
    expect(code).toContain("isDefault: true");
  });

  it("says that saving does not move an existing order", () => {
    /*
     * A customer who expects their parcel to be redirected will be
     * disappointed otherwise, and the order's address is a snapshot that
     * is never rewritten.
     *
     * The copy is **rendered**, not a comment, so the assertion is
     * made against the file with its comments left in.
     */
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src",
        "components",
        "account",
        "address-form.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("does not change where an");
  });
});

/**
 * The password form.
 */
describe("the password form", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "components",
      "account",
      "password-form.tsx",
    ),
  );

  it("asks for the current password", () => {
    expect(code).toContain('id="currentPassword"');
  });

  it("asks for the new password twice", () => {
    expect(code).toContain('id="newPassword"');
    expect(code).toContain('id="confirmPassword"');
  });

  it("posts to the password route", () => {
    expect(code).toContain('method: "POST"');
    expect(code).toContain("/api/account/password");
  });

  it("clears the fields after a successful change", () => {
    /*
     * The new password must not be left sitting in a field on a screen
     * somebody may walk away from.
     */
    expect(code).toContain('setNewPassword("")');
    expect(code).toContain('setConfirmPassword("")');
  });

  it("does not write the password through the profile route", () => {
    expect(code).not.toContain("/api/account/profile");
  });
});

/**
 * The storefront account menu.
 */
describe("the storefront account menu", () => {
  const code = readCode(
    path.join(process.cwd(), "src", "components", "layout", "account-menu.tsx"),
  );

  it("links to the settings page", () => {
    expect(code).toContain('href="/account/settings"');
  });

  it("keeps the settings link beside the orders link", () => {
    /*
     * The requirement is that the Settings entry sits in the same menu
     * as "Your orders" and the sign-out control — so all three are
     * present in the panel.
     */
    expect(code).toContain('href="/orders"');
    expect(code).toContain("LogoutButton");
  });
});

/**
 * The account page.
 */
describe("the account page", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "app",
      "(storefront)",
      "account",
      "page.tsx",
    ),
  );

  it("links to the settings page", () => {
    expect(code).toContain('href="/account/settings"');
  });
});

/**
 * The checkout pre-fill.
 */
describe("the checkout pre-fill", () => {
  const code = readCode(
    path.join(
      process.cwd(),
      "src",
      "app",
      "(storefront)",
      "checkout",
      "page.tsx",
    ),
  );

  it("reads the customer's saved address", () => {
    expect(code).toContain("getCustomerProfile(user.id)");
  });

  it("passes the saved address to the form", () => {
    expect(code).toContain("savedAddress={profile?.defaultAddress ?? null}");
  });

  it("still lets the customer change it", () => {
    /*
     * The saved address is a **pre-fill**, not a lock. The customer
     * always has the last word about where a parcel goes.
     */
    const formCode = readCode(
      path.join(
        process.cwd(),
        "src",
        "components",
        "commerce",
        "checkout-form.tsx",
      ),
    );

    expect(formCode).toContain("savedAddress?.addressLine1");
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
