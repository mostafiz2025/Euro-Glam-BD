import { AdminAction } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ADMIN_PROFILE_ACTIONS,
  AI_CONFIG_ACTIONS,
  AUDIT_ENTITY_TYPES,
  BRAND_ACTIONS,
  CATEGORY_ACTIONS,
  CONCERN_ACTIONS,
  COUPON_ACTIONS,
  HERO_BANNER_ACTIONS,
  ORDER_ACTIONS,
  PRODUCT_ACTIONS,
  REVIEW_ACTIONS,
  SMS_ACTIONS,
  SITE_SETTINGS_ACTIONS,
  isAuditEntityType,
  toAuditActor,
} from "@/lib/admin/audit";

/**
 * The audit vocabulary.
 *
 * The action list is a closed set, so the tests assert on its shape
 * rather than on individual values — a new action added to the enum must
 * also be wired into one of the three lookups, or it will never be
 * written by any service.
 */

describe("the audit action vocabulary", () => {
  it("is a closed set", () => {
    expect(Object.values(AdminAction).length).toBeGreaterThan(0);

    // Every enum member is a non-empty string.
    for (const action of Object.values(AdminAction)) {
      expect(typeof action).toBe("string");
      expect(action.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate members", () => {
    const values = Object.values(AdminAction);

    expect(new Set(values).size).toBe(values.length);
  });
});

describe("the action lookups", () => {
  it("maps every review action to a distinct enum member", () => {
    const actions = [
      REVIEW_ACTIONS.approve,
      REVIEW_ACTIONS.hide,
      REVIEW_ACTIONS.unhide,
    ];

    expect(new Set(actions).size).toBe(3);

    for (const action of actions) {
      expect(Object.values(AdminAction)).toContain(action);
    }
  });

  it("maps every order action to a distinct enum member", () => {
    const actions = [
      ORDER_ACTIONS.statusChanged,
      ORDER_ACTIONS.paymentStatusChanged,
      ORDER_ACTIONS.gatewaySettled,
      ORDER_ACTIONS.cancelled,
    ];

    expect(new Set(actions).size).toBe(4);

    for (const action of actions) {
      expect(Object.values(AdminAction)).toContain(action);
    }
  });

  it("maps every SMS action to a distinct enum member", () => {
    const actions = [SMS_ACTIONS.sweep, SMS_ACTIONS.sent, SMS_ACTIONS.resent];

    expect(new Set(actions).size).toBe(3);

    for (const action of actions) {
      expect(Object.values(AdminAction)).toContain(action);
    }
  });

  it("maps every product action to a distinct enum member", () => {
    const actions = [
      PRODUCT_ACTIONS.stockAdjusted,
      PRODUCT_ACTIONS.created,
      PRODUCT_ACTIONS.updated,
      PRODUCT_ACTIONS.deleted,
    ];

    expect(new Set(actions).size).toBe(4);

    for (const action of actions) {
      expect(Object.values(AdminAction)).toContain(action);
    }
  });

  it("maps every AI-configuration action to a distinct enum member", () => {
    const actions = [AI_CONFIG_ACTIONS.updated];

    expect(new Set(actions).size).toBe(1);

    for (const action of actions) {
      expect(Object.values(AdminAction)).toContain(action);
    }
  });

  it("maps every coupon action to a distinct enum member", () => {
    const actions = Object.values(COUPON_ACTIONS);

    expect(new Set(actions).size).toBe(actions.length);

    for (const action of actions) {
      expect(Object.values(AdminAction)).toContain(action);
    }
  });

  it("maps every admin-profile action to a distinct enum member", () => {
    const actions = Object.values(ADMIN_PROFILE_ACTIONS);

    expect(new Set(actions).size).toBe(actions.length);

    for (const action of actions) {
      expect(Object.values(AdminAction)).toContain(action);
    }
  });

  it("maps every hero-banner action to a distinct enum member", () => {
    const actions = Object.values(HERO_BANNER_ACTIONS);

    expect(new Set(actions).size).toBe(actions.length);

    for (const action of actions) {
      expect(Object.values(AdminAction)).toContain(action);
    }
  });

  it("never reuses one action for two meanings", () => {
    const all = [
      ...Object.values(REVIEW_ACTIONS),
      ...Object.values(ORDER_ACTIONS),
      ...Object.values(SMS_ACTIONS),
      ...Object.values(PRODUCT_ACTIONS),
      ...Object.values(AI_CONFIG_ACTIONS),
      ...Object.values(COUPON_ACTIONS),
      ...Object.values(HERO_BANNER_ACTIONS),
    ];

    expect(new Set(all).size).toBe(all.length);
  });

  it("covers every enum member through a lookup", () => {
    // If an action is added to the enum but no lookup points at it, no
    // service can ever write it — which is how an audit action goes
    // missing without anybody noticing.
    const covered = new Set([
      ...Object.values(REVIEW_ACTIONS),
      ...Object.values(ORDER_ACTIONS),
      ...Object.values(SMS_ACTIONS),
      ...Object.values(PRODUCT_ACTIONS),
      ...Object.values(AI_CONFIG_ACTIONS),
      ...Object.values(COUPON_ACTIONS),
      ...Object.values(CATEGORY_ACTIONS),
      ...Object.values(CONCERN_ACTIONS),
      ...Object.values(BRAND_ACTIONS),
      ...Object.values(HERO_BANNER_ACTIONS),
      ...Object.values(SITE_SETTINGS_ACTIONS),
      ...Object.values(ADMIN_PROFILE_ACTIONS),
    ]);

    for (const action of Object.values(AdminAction)) {
      expect(covered.has(action)).toBe(true);
    }
  });
});

describe("the entity type vocabulary", () => {
  it("is a closed set", () => {
    expect(AUDIT_ENTITY_TYPES.length).toBeGreaterThan(0);
    expect(new Set(AUDIT_ENTITY_TYPES).size).toBe(AUDIT_ENTITY_TYPES.length);
  });

  it("recognises a known entity type", () => {
    for (const type of AUDIT_ENTITY_TYPES) {
      expect(isAuditEntityType(type)).toBe(true);
    }
  });

  it("rejects an unknown entity type", () => {
    expect(isAuditEntityType("customer")).toBe(false);
    expect(isAuditEntityType("")).toBe(false);
    expect(isAuditEntityType("REVIEW")).toBe(false);
  });
});

describe("toAuditActor", () => {
  it("copies only the identity fields", () => {
    const actor = toAuditActor({
      id: "admin-1",
      email: "admin@example.com",
      name: "Admin One",
      role: "ADMIN" as never,
      phone: "+8801700000000",
      smsOptIn: true,
    });

    expect(actor).toEqual({
      id: "admin-1",
      name: "Admin One",
      email: "admin@example.com",
    });
  });

  it("does not carry the phone number or the opt-in flag", () => {
    // The audit trail records who acted. A customer's phone number has
    // no business in it.
    const actor = toAuditActor({
      id: "admin-1",
      email: "admin@example.com",
      name: "Admin One",
      role: "ADMIN" as never,
      phone: "+8801700000000",
      smsOptIn: true,
    });

    expect(Object.keys(actor).sort()).toEqual(["email", "id", "name"]);
    expect("phone" in actor).toBe(false);
    expect("smsOptIn" in actor).toBe(false);
  });
});
