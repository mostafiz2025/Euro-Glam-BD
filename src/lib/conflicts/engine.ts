import {
  CATALOGUE_BY_ID,
  familiesFor,
  type IngredientFamily,
  type IngredientId,
} from "./catalogue";
import { CONFLICT_RULES, type ConflictRule, type ConflictSeverity } from "./rules";

/**
 * The pure, deterministic ingredient conflict engine.
 *
 * ── The one rule that governs this file ─────────────────────────────────
 * This module performs **no I/O**, reads **no clock**, uses **no randomness**,
 * and calls **no AI**. It is a pure function of its inputs. Given the same
 * products and the same rules it returns the same result, every time, on
 * every machine.
 *
 * That property is not stylistic — it is what makes the safety path
 * trustworthy:
 *
 *   • Correctness — an LLM asked "do retinol and AHA conflict?" will
 *     sometimes say no. A `BLOCK` rule in code cannot be wrong.
 *   • Auditability — "Rule AHA_RETINOL_BLOCK, severity BLOCK" can be shown
 *     to a customer and defended to a regulator. "The model said so" cannot.
 *   • Cost and latency — this runs on every add-to-cart. A rule array is
 *     microseconds; an LLM round-trip is seconds and money.
 *
 * The LLM may only *phrase* a result the engine already decided. See
 * DECISIONS.md #7.
 */

/**
 * The minimal shape the engine needs from a product.
 *
 * Structural typing on purpose: the engine accepts a Prisma `Product`, a
 * DTO, or a plain object in a test, without importing Prisma into the
 * safety-critical module. That keeps this file free of database types and
 * trivially unit-testable.
 */
export type ConflictProduct = {
  readonly id: string;
  readonly ingredientTags: readonly string[];
};

/**
 * A conflict that the engine has decided on.
 */
export type EvaluatedConflict = {
  /** The rule that fired. */
  readonly ruleId: string;
  readonly severity: ConflictSeverity;
  /** Short heading, from the rule. */
  readonly title: string;
  /** Why this is a problem, from the rule. */
  readonly message: string;
  /** What to do about it, from the rule. */
  readonly remedy: string;
  /** How to space the two actives, from the rule. */
  readonly spacingAdvice: string;
  /**
   * The products involved, sorted ascending.
   *
   * For a cross-ingredient rule this is the two products that carry the two
   * sides of the pair. For a same-ingredient rule it is every product that
   * carries the shared ingredient.
   */
  readonly involvedProductIds: string[];
  /**
   * The ingredient IDs (or family names) that the rule matched.
   *
   * For a same-ingredient rule this is a single-element array.
   */
  readonly ingredientIds: IngredientId[];
};

/**
 * The result of evaluating a set of products against the rule set.
 */
export type ConflictEvaluation = {
  /** Every conflict found, sorted `BLOCK` first, then by rule ID. */
  readonly conflicts: EvaluatedConflict[];
  /**
   * Products involved in at least one `BLOCK` conflict.
   *
   * A product that appears in a `BLOCK` conflict must not be recommended
   * alongside the products already in the cart.
   */
  readonly blockedProductIds: string[];
  /**
   * Products involved in at least one `WARN` conflict and no `BLOCK` conflict.
   *
   * Kept separate from `blockedProductIds` so the caller can distinguish
   * "do not recommend" from "recommend with a warning".
   */
  readonly warnedProductIds: string[];
};

/**
 * The severity sort order. `BLOCK` must come before `WARN`.
 */
const SEVERITY_ORDER: Readonly<Record<ConflictSeverity, number>> = {
  BLOCK: 0,
  WARN: 1,
};

/**
 * The set of ingredient IDs and families carried by one product.
 *
 * A product tagged `GLYCOLIC_ACID` carries the ID `GLYCOLIC_ACID` and the
 * family `AHA`, so a rule naming either one matches it.
 */
type IngredientTokens = ReadonlySet<string>;

/**
 * Expands a product's tags into the set of tokens it satisfies.
 *
 * Tags are normalised to upper case and trimmed. An unrecognised tag is
 * kept as-is: it may still match a rule that names that specific ID, and
 * silently dropping it would make a conflict go unnoticed.
 */
function tokensFor(product: ConflictProduct): IngredientTokens {
  const tokens = new Set<string>();

  for (const rawTag of product.ingredientTags) {
    const tag = rawTag.trim().toUpperCase();

    if (tag.length === 0) continue;

    tokens.add(tag);

    for (const family of familiesFor(tag as IngredientId)) {
      tokens.add(family);
    }
  }

  return tokens;
}

/**
 * A product paired with its resolved ingredient tokens.
 */
type IndexedProduct = {
  readonly id: string;
  readonly tokens: IngredientTokens;
};

/**
 * Indexes products by id and resolves their ingredient tokens.
 *
 * Duplicate product IDs are collapsed: the same product must not appear
 * twice in the output, or a cart containing the same product twice would
 * look like a two-product conflict.
 */
function indexProducts(products: readonly ConflictProduct[]): IndexedProduct[] {
  const byId = new Map<string, IndexedProduct>();

  for (const product of products) {
    if (byId.has(product.id)) continue;

    byId.set(product.id, {
      id: product.id,
      tokens: tokensFor(product),
    });
  }

  return [...byId.values()];
}

/**
 * Returns true when a product's tokens satisfy one side of a rule.
 */
function satisfies(indexed: IndexedProduct, ingredient: IngredientId): boolean {
  return indexed.tokens.has(ingredient.trim().toUpperCase());
}

/**
 * Evaluates a set of products against a set of conflict rules.
 *
 * This is the single entry point of the safety path. It is pure: no I/O, no
 * clock, no randomness, no model calls.
 *
 * ### How a rule fires
 *
 * A rule names two ingredients (or families), `ingredientA` and
 * `ingredientB`.
 *
 * • **Cross-ingredient rules** (`ingredientA !== ingredientB`) fire when two
 *   *different* products each satisfy one side of the pair. So a rule
 *   `AHA × RETINOID` fires when one product is an AHA and a different
 *   product is a retinoid.
 *
 * • **Same-ingredient rules** (`ingredientA === ingredientB`) fire when two
 *   *different* products both satisfy that single ingredient. So a rule
 *   `VITAMIN_C × VITAMIN_C` fires when two products both carry vitamin C.
 *
 * In both cases, the *same* product satisfying both sides does not fire the
 * rule. A single retinol-and-AHA product is one formulation the
 * manufacturer has already balanced, and it is not a conflict with itself.
 *
 * ### Ordering
 *
 * Results are sorted by severity (`BLOCK` before `WARN`), then by rule ID.
 * Both are total orders, so the output is fully deterministic — which
 * matters for snapshot tests and for a stable UI.
 *
 * @param products - The products to check, e.g. the cart plus the candidate set.
 * @param rules    - The rules to apply. Defaults to the platform rule set.
 *
 * ### Why the default is the platform rule set
 *
 * An earlier version of this function defaulted `rules` to an **empty
 * array**. That was a safety defect, not a convenience: any caller that
 * imported the engine directly and forgot to pass rules got a silent
 * no-op — zero conflicts, no error, a `BLOCK` rule that simply never
 * fired. On the checkout path that is the worst possible failure mode,
 * because the customer is told "no conflicts found" and the order goes
 * through.
 *
 * The default is now `CONFLICT_RULES`. To evaluate against an empty rule
 * set you must say so explicitly, and a test that asserts "no conflicts"
 * must say so explicitly too.
 */
export function evaluateConflicts(
  products: readonly ConflictProduct[],
  rules: readonly ConflictRule[] = CONFLICT_RULES,
): ConflictEvaluation {
  const indexed = indexProducts(products);

  if (indexed.length < 2 || rules.length === 0) {
    return { conflicts: [], blockedProductIds: [], warnedProductIds: [] };
  }

  const evaluated: EvaluatedConflict[] = [];

  for (const rule of rules) {
    const sameIngredient = rule.ingredientA === rule.ingredientB;

    // For a cross-ingredient rule, find every (A-side product, B-side
    // product) pair. For a same-ingredient rule, find every pair of products
    // that both carry the shared ingredient.
    const involved = new Set<string>();
    const matchedIngredients = new Set<string>();

    for (const first of indexed) {
      const firstMatches = satisfies(first, rule.ingredientA);

      if (!firstMatches) continue;

      matchedIngredients.add(rule.ingredientA.trim().toUpperCase());

      for (const second of indexed) {
        // A product never conflicts with itself.
        if (first.id === second.id) continue;

        if (sameIngredient) {
          // Both sides are the same ingredient — the second product must
          // also carry it.
          if (!satisfies(second, rule.ingredientB)) continue;
        } else {
          // The two sides must be satisfied by two *different* products,
          // and the second must satisfy the other side of the pair.
          if (!satisfies(second, rule.ingredientB)) continue;
        }

        involved.add(first.id);
        involved.add(second.id);
      }
    }

    if (involved.size === 0) continue;

    const ingredientIds: IngredientId[] = [...matchedIngredients]
      .sort()
      .map((token) => token as IngredientId);

    if (sameIngredient) {
      // A same-ingredient rule reports one ingredient.
      ingredientIds.length = 0;
      ingredientIds.push(rule.ingredientA.trim().toUpperCase() as IngredientId);
    }

    evaluated.push({
      ruleId: rule.id,
      severity: rule.severity,
      title: rule.title,
      message: rule.message,
      remedy: rule.remedy,
      spacingAdvice: rule.spacingAdvice,
      involvedProductIds: [...involved].sort(),
      ingredientIds,
    });
  }

  evaluated.sort(compareConflicts);

  const blocked = new Set<string>();
  const warned = new Set<string>();

  for (const conflict of evaluated) {
    const target = conflict.severity === "BLOCK" ? blocked : warned;

    for (const productId of conflict.involvedProductIds) {
      target.add(productId);
    }
  }

  // A product with both a BLOCK and a WARN is blocked. The stricter
  // classification always wins.
  for (const productId of blocked) {
    warned.delete(productId);
  }

  return {
    conflicts: evaluated,
    blockedProductIds: [...blocked].sort(),
    warnedProductIds: [...warned].sort(),
  };
}

/**
 * Compares two conflicts for the deterministic output order.
 *
 * `BLOCK` before `WARN`, then by rule ID. A rule ID comparison is a plain
 * code-unit comparison, so it does not depend on the host locale.
 */
function compareConflicts(a: EvaluatedConflict, b: EvaluatedConflict): number {
  const bySeverity =
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];

  if (bySeverity !== 0) return bySeverity;

  if (a.ruleId === b.ruleId) return 0;

  return a.ruleId < b.ruleId ? -1 : 1;
}

/**
 * Returns the display names for a list of ingredient IDs.
 *
 * Used when phrasing a conflict for a customer. Unknown IDs fall back to
 * their raw value rather than being dropped.
 */
export function displayNamesFor(ingredientIds: readonly IngredientId[]): string[] {
  return ingredientIds.map((ingredientId) => {
    const entry = CATALOGUE_BY_ID.get(ingredientId);
    return entry ? entry.displayName : ingredientId;
  });
}

/**
 * Returns the families an ingredient belongs to, for callers that need to
 * explain why a rule matched.
 */
export function ingredientFamilies(ingredientId: IngredientId): IngredientFamily[] {
  return familiesFor(ingredientId);
}
