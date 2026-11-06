import { describe, expect, it } from "vitest";

import {
  CONFLICT_RULES,
  evaluateConflicts,
  evaluateConflictsWith,
  filterBlockedCandidates,
  summariseConflicts,
  type ConflictProduct,
} from "@/lib/conflict-engine";
import { evaluateConflicts as evaluateConflictsRaw } from "@/lib/conflicts/engine";

/**
 * Conflict engine tests.
 *
 * These are the most valuable tests in the codebase. The engine is the
 * safety-critical path: it is the thing that stops the platform from
 * recommending a retinol next to an AHA. Nothing about the LLM can be
 * trusted to do this job, so the code that does it must be proven correct
 * here.
 *
 * The properties that matter:
 *
 *   1. Correctness  — the right rules fire on the right pairs.
 *   2. Determinism  — the same input always gives the same output, and the
 *                      output order is stable.
 *   3. Purity       — no I/O, no clock, no randomness.
 *   4. Non-regression — a product never conflicts with itself.
 */

/**
 * Builds a product for the test.
 */
function product(id: string, ...tags: string[]): ConflictProduct {
  return { id, ingredientTags: tags };
}

describe("evaluateConflicts", () => {
  describe("the default rule set can never be empty", () => {
    it("applies the platform rules when no rule set is supplied", () => {
      // Regression guard.
      //
      // The raw engine used to default `rules` to an empty array. Any
      // caller that imported it directly — which is exactly what the cart
      // and order services did — silently got zero conflicts: no error,
      // no warning, and a BLOCK rule that simply never fired. On the
      // checkout path that meant telling a customer "no conflicts found"
      // while ordering retinol next to an AHA.
      //
      // The default is now the platform rule set, so importing the engine
      // directly is safe.
      const result = evaluateConflictsRaw([
        product("p1", "RETINOL"),
        product("p2", "GLYCOLIC_ACID"),
      ]);

      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts.some((c) => c.severity === "BLOCK")).toBe(true);
      expect(result.blockedProductIds).toEqual(["p1", "p2"]);
    });

    it("matches the wrapper's result for the same input", () => {
      const products = [
        product("p1", "RETINOL"),
        product("p2", "GLYCOLIC_ACID"),
      ];

      expect(evaluateConflictsRaw(products)).toEqual(
        evaluateConflicts(products),
      );
    });

    it("still allows an explicitly empty rule set", () => {
      // An empty rule set must remain possible for a caller that really
      // wants it — but it now has to be asked for.
      const result = evaluateConflictsRaw(
        [product("p1", "RETINOL"), product("p2", "GLYCOLIC_ACID")],
        [],
      );

      expect(result.conflicts).toEqual([]);
    });
  });

  describe("empty and trivial inputs", () => {
    it("returns no conflicts for an empty product list", () => {
      const result = evaluateConflicts([]);

      expect(result.conflicts).toEqual([]);
      expect(result.blockedProductIds).toEqual([]);
      expect(result.warnedProductIds).toEqual([]);
    });

    it("returns no conflicts for a single product", () => {
      const result = evaluateConflicts([product("p1", "RETINOL", "NIACINAMIDE")]);

      expect(result.conflicts).toEqual([]);
    });

    it("returns no conflicts for two compatible products", () => {
      const result = evaluateConflicts([
        product("p1", "NIACINAMIDE", "HYALURONIC_ACID"),
        product("p2", "GLYCERIN", "CERAMIDES"),
      ]);

      expect(result.conflicts).toEqual([]);
      expect(result.blockedProductIds).toEqual([]);
    });

    it("returns no conflicts when no rules are supplied", () => {
      const result = evaluateConflictsWith(
        [product("p1", "RETINOL"), product("p2", "AHA")],
        [],
      );

      expect(result.conflicts).toEqual([]);
    });
  });

  describe("BLOCK severity", () => {
    it("blocks a retinol and an AHA", () => {
      const result = evaluateConflicts([
        product("retinol_product", "RETINOL"),
        product("aha_product", "AHA"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("AHA_RETINOL_BLOCK");
      expect(result.conflicts[0]?.severity).toBe("BLOCK");
      expect(result.blockedProductIds).toEqual([
        "aha_product",
        "retinol_product",
      ]);
    });

    it("blocks a retinol and a specific AHA molecule via the family", () => {
      const result = evaluateConflicts([
        product("retinol_product", "RETINOL"),
        product("glycolic_product", "GLYCOLIC_ACID"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("AHA_RETINOL_BLOCK");
      expect(result.conflicts[0]?.severity).toBe("BLOCK");
    });

    it("blocks a retinoid and an AHA", () => {
      const result = evaluateConflicts([
        product("retinyl_product", "RETINYL_PALMITATE"),
        product("lactic_product", "LACTIC_ACID"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("AHA_RETINOL_BLOCK");
    });

    it("includes both products in involvedProductIds", () => {
      const result = evaluateConflicts([
        product("a", "RETINOL"),
        product("b", "AHA"),
      ]);

      expect(result.conflicts[0]?.involvedProductIds).toEqual(["a", "b"]);
    });

    it("carries an explanation and a remedy", () => {
      const result = evaluateConflicts([
        product("a", "RETINOL"),
        product("b", "AHA"),
      ]);

      const conflict = result.conflicts[0];

      expect(conflict?.message.length).toBeGreaterThan(0);
      expect(conflict?.remedy.length).toBeGreaterThan(0);
      expect(conflict?.title.length).toBeGreaterThan(0);
      expect(conflict?.spacingAdvice.length).toBeGreaterThan(0);
    });
  });

  describe("WARN severity", () => {
    it("warns for a BHA and a retinol", () => {
      const result = evaluateConflicts([
        product("salicylic_product", "SALICYLIC_ACID"),
        product("retinol_product", "RETINOL"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("BHA_RETINOL_WARN");
      expect(result.conflicts[0]?.severity).toBe("WARN");
      expect(result.warnedProductIds).toEqual([
        "retinol_product",
        "salicylic_product",
      ]);
      expect(result.blockedProductIds).toEqual([]);
    });

    it("warns for an AHA and a BHA", () => {
      const result = evaluateConflicts([
        product("glycolic_product", "GLYCOLIC_ACID"),
        product("salicylic_product", "SALICYLIC_ACID"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("AHA_BHA_WARN");
      expect(result.conflicts[0]?.severity).toBe("WARN");
    });

    it("warns for two vitamin-C products", () => {
      const result = evaluateConflicts([
        product("serum", "VITAMIN_C"),
        product("cream", "VITAMIN_C"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("VITAMIN_C_DUPLICATE_WARN");
      expect(result.conflicts[0]?.severity).toBe("WARN");
      expect(result.conflicts[0]?.ingredientIds).toEqual(["VITAMIN_C"]);
    });

    it("warns for two retinoids", () => {
      const result = evaluateConflicts([
        product("retinol_product", "RETINOL"),
        product("retinyl_product", "RETINYL_PALMITATE"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("RETINOL_DUPLICATE_WARN");
      expect(result.conflicts[0]?.severity).toBe("WARN");
    });

    it("warns for benzoyl peroxide and an AHA", () => {
      const result = evaluateConflicts([
        product("bpo_product", "BENZOYL_PEROXIDE"),
        product("glycolic_product", "GLYCOLIC_ACID"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("BENZOYL_PEROXIDE_AHA_WARN");
      expect(result.conflicts[0]?.severity).toBe("WARN");
    });
  });

  describe("a product never conflicts with itself", () => {
    it("does not fire a cross-ingredient rule for a single dual-ingredient product", () => {
      // A retinol-and-AHA product is one formula the manufacturer has
      // already balanced. It is not a conflict with itself.
      const result = evaluateConflicts([
        product("combined", "RETINOL", "AHA"),
      ]);

      expect(result.conflicts).toEqual([]);
    });

    it("does not fire a same-ingredient rule for a single product", () => {
      const result = evaluateConflicts([product("combined", "VITAMIN_C")]);

      expect(result.conflicts).toEqual([]);
    });

    it("still fires when two products each carry both ingredients", () => {
      const result = evaluateConflicts([
        product("a", "RETINOL", "AHA"),
        product("b", "RETINOL", "AHA"),
      ]);

      expect(result.conflicts.length).toBeGreaterThan(0);
    });
  });

  describe("ordering", () => {
    it("sorts BLOCK conflicts before WARN conflicts", () => {
      const result = evaluateConflicts([
        product("retinol", "RETINOL"),
        product("salicylic", "SALICYLIC_ACID"),
        product("glycolic", "GLYCOLIC_ACID"),
      ]);

      const severities = result.conflicts.map((conflict) => conflict.severity);
      const firstWarn = severities.indexOf("WARN");
      const lastBlock = severities.lastIndexOf("BLOCK");

      expect(firstWarn).toBeGreaterThan(-1);
      expect(lastBlock).toBeLessThan(firstWarn);
    });

    it("sorts by ruleId within the same severity", () => {
      const result = evaluateConflicts([
        product("retinol", "RETINOL"),
        product("vitamin_c", "VITAMIN_C"),
        product("salicylic", "SALICYLIC_ACID"),
      ]);

      const warnRuleIds = result.conflicts
        .filter((conflict) => conflict.severity === "WARN")
        .map((conflict) => conflict.ruleId);

      const sorted = [...warnRuleIds].sort();

      expect(warnRuleIds).toEqual(sorted);
    });

    it("produces a stable order across repeated calls", () => {
      const products = [
        product("a", "RETINOL"),
        product("b", "AHA"),
        product("c", "VITAMIN_C"),
        product("d", "VITAMIN_C"),
      ];

      const first = evaluateConflicts(products);
      const second = evaluateConflicts(products);

      expect(first.conflicts.map((c) => c.ruleId)).toEqual(
        second.conflicts.map((c) => c.ruleId),
      );
    });
  });

  describe("purity", () => {
    it("returns an identical result for identical input", () => {
      const products = [
        product("a", "RETINOL"),
        product("b", "AHA"),
        product("c", "NIACINAMIDE"),
        product("d", "VITAMIN_C"),
      ];

      const first = evaluateConflicts(products);
      const second = evaluateConflicts(products);

      expect(second).toEqual(first);
    });

    it("does not mutate the input array", () => {
      const products = [
        product("a", "RETINOL"),
        product("b", "AHA"),
      ];

      const snapshot = JSON.stringify(products);

      evaluateConflicts(products);

      expect(JSON.stringify(products)).toBe(snapshot);
    });

    it("does not mutate the rules array", () => {
      const snapshot = JSON.stringify(CONFLICT_RULES);

      evaluateConflicts([
        product("a", "RETINOL"),
        product("b", "AHA"),
      ]);

      expect(JSON.stringify(CONFLICT_RULES)).toBe(snapshot);
    });
  });

  describe("classification", () => {
    it("classifies a product with both a BLOCK and a WARN as blocked only", () => {
      // The retinol conflicts with the AHA (BLOCK) and with the second
      // vitamin-C product (WARN). The stricter classification wins.
      const result = evaluateConflicts([
        product("retinol", "RETINOL"),
        product("aha", "AHA"),
        product("vitamin_c", "VITAMIN_C"),
        product("vitamin_c_2", "VITAMIN_C"),
      ]);

      expect(result.blockedProductIds).toContain("retinol");
      expect(result.warnedProductIds).not.toContain("retinol");
    });

    it("returns sorted id lists", () => {
      const result = evaluateConflicts([
        product("zeta", "RETINOL"),
        product("alpha", "AHA"),
      ]);

      expect(result.blockedProductIds).toEqual([...result.blockedProductIds].sort());
      expect(result.warnedProductIds).toEqual([...result.warnedProductIds].sort());
    });
  });

  describe("input handling", () => {
    it("handles a duplicate product id without double-reporting", () => {
      const result = evaluateConflicts([
        product("same", "RETINOL"),
        product("same", "AHA"),
      ]);

      expect(result.conflicts).toEqual([]);
    });

    it("ignores empty and whitespace-only tags", () => {
      const result = evaluateConflicts([
        product("a", "RETINOL", "", "   "),
        product("b", "AHA"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("AHA_RETINOL_BLOCK");
    });

    it("matches tags case-insensitively", () => {
      const result = evaluateConflicts([
        product("a", "retinol"),
        product("b", "aha"),
      ]);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("AHA_RETINOL_BLOCK");
    });

    it("matches an unknown tag against a rule that names it directly", () => {
      // An ingredient not in the catalogue must still be matchable, or a
      // conflict could go unnoticed.
      const result = evaluateConflictsWith(
        [product("a", "EXOTIC_ACTIVE"), product("b", "RETINOL")],
        [
          {
            id: "CUSTOM",
            ingredientA: "EXOTIC_ACTIVE" as never,
            ingredientB: "RETINOL" as never,
            severity: "WARN",
            title: "Custom rule",
            message: "Custom message",
            remedy: "Custom remedy",
            spacingAdvice: "Custom spacing",
          },
        ],
      );

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.ruleId).toBe("CUSTOM");
    });
  });

  describe("rule integrity", () => {
    it("has unique rule ids", () => {
      const ids = CONFLICT_RULES.map((rule) => rule.id);

      expect(new Set(ids).size).toBe(ids.length);
    });

    it("gives every rule a message and a remedy", () => {
      for (const rule of CONFLICT_RULES) {
        expect(rule.message.length, `rule ${rule.id} message`).toBeGreaterThan(0);
        expect(rule.remedy.length, `rule ${rule.id} remedy`).toBeGreaterThan(0);
        expect(rule.title.length, `rule ${rule.id} title`).toBeGreaterThan(0);
      }
    });

    it("uses only the two supported severities", () => {
      for (const rule of CONFLICT_RULES) {
        expect(["BLOCK", "WARN"]).toContain(rule.severity);
      }
    });
  });
});

describe("filterBlockedCandidates", () => {
  it("excludes a candidate that blocks with a cart product", () => {
    const { allowed, blocked } = filterBlockedCandidates(
      [product("cart_retinol", "RETINOL")],
      [product("candidate_aha", "AHA")],
    );

    expect(allowed.map((p) => p.id)).toEqual([]);
    expect(blocked.map((p) => p.id)).toEqual(["candidate_aha"]);
  });

  it("keeps a candidate that only warns with a cart product", () => {
    const { allowed, blocked } = filterBlockedCandidates(
      [product("cart_bha", "SALICYLIC_ACID")],
      [product("candidate_retinol", "RETINOL")],
    );

    expect(allowed.map((p) => p.id)).toEqual(["candidate_retinol"]);
    expect(blocked).toEqual([]);
  });

  it("keeps a candidate that conflicts only with another candidate", () => {
    // The user will buy one of the two, not both — so neither is blocked.
    const { allowed, blocked } = filterBlockedCandidates(
      [product("cart_niacinamide", "NIACINAMIDE")],
      [product("candidate_retinol", "RETINOL"), product("candidate_aha", "AHA")],
    );

    expect(allowed.map((p) => p.id)).toEqual([
      "candidate_retinol",
      "candidate_aha",
    ]);
    expect(blocked).toEqual([]);
  });

  it("keeps every candidate when the cart is empty", () => {
    const { allowed, blocked } = filterBlockedCandidates(
      [],
      [product("a", "RETINOL"), product("b", "AHA")],
    );

    expect(allowed).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });
});

describe("summariseConflicts", () => {
  it("reports when there is no conflict", () => {
    const result = evaluateConflicts([]);

    expect(summariseConflicts(result)).toContain("No ingredient conflicts");
  });

  it("counts blocks and warnings", () => {
    // Three products produce three conflicts: one BLOCK (retinol + AHA)
    // and two WARNs (AHA + BHA, and BHA + retinol). Each pair is counted
    // separately, which is the point — the customer needs to know about
    // every combination, not just the worst one.
    const result = evaluateConflicts([
      product("retinol", "RETINOL"),
      product("aha", "AHA"),
      product("salicylic", "SALICYLIC_ACID"),
    ]);

    const summary = summariseConflicts(result);

    expect(summary).toContain("1 blocking");
    expect(summary).toContain("2 combinations to watch");
  });
});
