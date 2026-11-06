import { AdminAction } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { describeChanges } from "@/app/admin/audit-logs/page";
import { auditActionLabel } from "@/lib/admin/audit-logs";

/**
 * The audit-trail explorer's pure parts.
 *
 * Two things are tested here, and both are things a page cannot be
 * trusted to get right by eye:
 *
 *   1. **`describeChanges`** — the diff renderer. It turns the
 *      `before` / `after` JSON blobs into "field: old → new" lines.
 *      The properties that matter: a field that did not change is not
 *      shown, a field that was set reads "(not set)" on its missing
 *      side, and a malformed snapshot produces no changes rather than
 *      throwing.
 *
 *   2. **`auditActionLabel`** — the human label for an action. Every
 *      action in the enum must have a label, so the trail never shows
 *      a raw constant to an admin.
 */

describe("describeChanges", () => {
  it("returns nothing when the two snapshots are identical", () => {
    expect(
      describeChanges({ percentOff: 10 }, { percentOff: 10 }),
    ).toEqual([]);
  });

  it("describes a changed value", () => {
    const changes = describeChanges(
      { percentOff: 10 },
      { percentOff: 20 },
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("percentOff");
    expect(changes[0].from).toBe("10");
    expect(changes[0].to).toBe("20");
  });

  it("describes only the fields that changed", () => {
    const changes = describeChanges(
      { percentOff: 10, description: "Eid" },
      { percentOff: 20, description: "Eid" },
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("percentOff");
  });

  it("reads a cleared field as '(not set)'", () => {
    const changes = describeChanges(
      { amountOffPaisa: 15_000 },
      { amountOffPaisa: null },
    );

    // 15,000 poisha is 150 taka, formatted the way the rest of the
    // codebase formats money.
    expect(changes[0].from).toBe("৳150");
    expect(changes[0].to).toBe("(not set)");
  });

  it("reads a set field as '(not set)' on its missing side", () => {
    const changes = describeChanges(
      { percentOff: null },
      { percentOff: 20 },
    );

    expect(changes[0].from).toBe("(not set)");
    expect(changes[0].to).toBe("20");
  });

  it("renders a boolean as yes or no", () => {
    const changes = describeChanges({ isActive: true }, { isActive: false });

    expect(changes[0].from).toBe("yes");
    expect(changes[0].to).toBe("no");
  });

  it("renders a money field as taka", () => {
    // A raw "95000" in a diff is unreadable where "৳950" is not.
    const changes = describeChanges(
      { pricePaisa: 95_000 },
      { pricePaisa: 120_000 },
    );

    expect(changes[0].from).toBe("৳950");
    expect(changes[0].to).toBe("৳1,200");
  });

  it("does not render a count as money", () => {
    // The heuristic is the field's *name*, not the value: a
    // `usageCount` field is not money, and both happen to be integers.
    const changes = describeChanges(
      { usageCount: 10 },
      { usageCount: 20 },
    );

    expect(changes[0].from).toBe("10");
    expect(changes[0].to).toBe("20");
  });

  it("survives a null snapshot", () => {
    expect(describeChanges(null, null)).toEqual([]);
  });

  it("survives a null before-snapshot", () => {
    const changes = describeChanges(null, { percentOff: 20 });

    expect(changes).toHaveLength(1);
    expect(changes[0].from).toBe("(not set)");
  });

  it("survives an array snapshot", () => {
    expect(describeChanges([1, 2, 3], [1, 2, 3])).toEqual([]);
  });

  it("survives a primitive snapshot", () => {
    expect(describeChanges("nonsense", "nonsense")).toEqual([]);
  });

  it("survives an undefined snapshot", () => {
    expect(describeChanges(undefined, undefined)).toEqual([]);
  });

  it("lists every changed field", () => {
    const changes = describeChanges(
      { percentOff: 10, usageLimit: 100, isActive: true },
      { percentOff: 20, usageLimit: 200, isActive: true },
    );

    expect(changes.map((change) => change.field).sort()).toEqual([
      "percentOff",
      "usageLimit",
    ]);
  });
});

describe("auditActionLabel", () => {
  it("gives every action in the enum a label", () => {
    // A raw enum constant in the trail is a constant the admin has to
    // decode. Every action must have prose.
    for (const action of Object.values(AdminAction)) {
      const label = auditActionLabel(action);

      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(action);
    }
  });

  it("does not give two actions the same label", () => {
    const labels = Object.values(AdminAction).map((action) =>
      auditActionLabel(action),
    );

    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names the coupon actions", () => {
    expect(auditActionLabel(AdminAction.COUPON_CREATED)).toBe(
      "Created a coupon",
    );
    expect(auditActionLabel(AdminAction.COUPON_UPDATED)).toBe(
      "Changed a coupon",
    );
    expect(auditActionLabel(AdminAction.COUPON_DELETED)).toBe(
      "Deactivated a coupon",
    );
  });
});
