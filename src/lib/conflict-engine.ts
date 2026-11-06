/**
 * Ingredient conflict-checking engine — the public entry point.
 *
 * This module is the single import the rest of the application needs. It
 * re-exports the catalogue, the rule set and the pure evaluation function
 * under one roof, so a caller does not have to know that the implementation
 * is split across `src/lib/conflicts/`.
 *
 * Everything re-exported here is pure and deterministic. The engine performs
 * no I/O, reads no clock, uses no randomness and calls no AI. See
 * `src/lib/conflicts/engine.ts` for the full rationale.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 * ```ts
 * import { evaluateConflicts } from "@/lib/conflict-engine";
 *
 * const result = evaluateConflicts([
 *   { id: "prod_a", ingredientTags: ["RETINOL"] },
 *   { id: "prod_b", ingredientTags: ["AHA", "NIACINAMIDE"] },
 * ]);
 *
 * result.conflicts[0]?.severity;            // "BLOCK"
 * result.conflicts[0]?.ruleId;              // "AHA_RETINOL_BLOCK"
 * result.conflicts[0]?.remedy;              // human-readable guidance
 * result.blockedProductIds;                 // ["prod_a", "prod_b"]
 * ```
 */

import { CONFLICT_RULES } from "./conflicts/rules";
import {
  evaluateConflicts as evaluateConflictsInternal,
  type ConflictEvaluation,
  type ConflictProduct,
} from "./conflicts/engine";
import type { ConflictRule } from "./conflicts/rules";

export {
  CATALOGUE,
  CATALOGUE_BY_ALIAS,
  CATALOGUE_BY_ID,
  INGREDIENT_FAMILIES,
  displayNameFor,
  familiesFor,
  resolveIngredient,
  resolveIngredientId,
  type CatalogueEntry,
  type IngredientFamily,
  type IngredientId,
} from "./conflicts/catalogue";

export {
  CONFLICT_RULES,
  CONFLICT_RULES_BY_ID,
  type ConflictRule,
  type ConflictSeverity,
} from "./conflicts/rules";

export {
  displayNamesFor,
  ingredientFamilies,
  type ConflictEvaluation,
  type ConflictProduct,
  type EvaluatedConflict,
} from "./conflicts/engine";

/**
 * Evaluates a set of products against the platform rule set.
 *
 * This is a thin wrapper over the pure engine that applies the default
 * rules. Use `evaluateConflictsWith` when you need to supply a custom rule
 * set (for example, in a test).
 *
 * @param products - The products to check. Each needs an `id` and its
 *                   `ingredientTags`.
 */
export function evaluateConflicts(
  products: readonly ConflictProduct[],
): ConflictEvaluation {
  return evaluateConflictsWith(products, CONFLICT_RULES);
}

/**
 * Evaluates a set of products against an explicit rule set.
 *
 * @param products - The products to check.
 * @param rules    - The rules to apply.
 */
export function evaluateConflictsWith(
  products: readonly ConflictProduct[],
  rules: readonly ConflictRule[],
): ConflictEvaluation {
  return evaluateConflictsInternal(products, rules);
}

/**
 * Filters a list of products down to those that may safely be recommended
 * alongside `existingProducts`.
 *
 * A candidate is excluded when it takes part in a `BLOCK` conflict with
 * anything in `existingProducts`. `WARN` conflicts do not exclude a
 * candidate — they are surfaced alongside the recommendation.
 *
 * This is the function the advisor service calls: "given what is already in
 * the cart, which of these may I still suggest?"
 *
 * @param existingProducts - Products the recommendation must coexist with.
 * @param candidates       - Products under consideration.
 * @param rules            - The rules to apply.
 */
export function filterBlockedCandidates(
  existingProducts: readonly ConflictProduct[],
  candidates: readonly ConflictProduct[],
  rules: readonly ConflictRule[] = CONFLICT_RULES,
): {
  allowed: ConflictProduct[];
  blocked: ConflictProduct[];
  evaluation: ConflictEvaluation;
} {
  const evaluation = evaluateConflictsInternal(
    [...existingProducts, ...candidates],
    rules,
  );

  const blockedIds = new Set(evaluation.blockedProductIds);

  // A candidate is only blocked if the conflict involves a product that is
  // already in the cart. A conflict between two *candidates* is not a
  // reason to drop either one — the user will only buy one of them.
  const existingIds = new Set(existingProducts.map((product) => product.id));

  const blockedByExisting = new Set<string>();

  for (const conflict of evaluation.conflicts) {
    if (conflict.severity !== "BLOCK") continue;

    const touchesExisting = conflict.involvedProductIds.some((id) =>
      existingIds.has(id),
    );

    if (!touchesExisting) continue;

    for (const id of conflict.involvedProductIds) {
      if (!existingIds.has(id)) blockedByExisting.add(id);
    }
  }

  const allowed = candidates.filter((product) => !blockedByExisting.has(product.id));
  const blocked = candidates.filter((product) => blockedByExisting.has(product.id));

  // `blockedIds` is intentionally unused for the partition — the partition
  // above is the narrower, correct one. It is retained here to make the
  // distinction explicit for future callers that want the raw set.
  void blockedIds;

  return { allowed, blocked, evaluation };
}

/**
 * Summarises an evaluation into a short, customer-facing line.
 *
 * Used by the UI to render a one-line summary above the detailed conflict
 * list. Deterministic and derived purely from the evaluation.
 */
export function summariseConflicts(evaluation: ConflictEvaluation): string {
  const blocks = evaluation.conflicts.filter((c) => c.severity === "BLOCK");
  const warns = evaluation.conflicts.filter((c) => c.severity === "WARN");

  if (blocks.length === 0 && warns.length === 0) {
    return "No ingredient conflicts found in this combination.";
  }

  const parts: string[] = [];

  if (blocks.length > 0) {
    parts.push(
      `${blocks.length} blocking ${blocks.length === 1 ? "combination" : "combinations"}`,
    );
  }

  if (warns.length > 0) {
    parts.push(
      `${warns.length} ${warns.length === 1 ? "combination to" : "combinations to"} watch`,
    );
  }

  return `${parts.join(" and ")} found in this combination.`;
}
