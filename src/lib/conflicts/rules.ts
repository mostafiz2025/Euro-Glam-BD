import type { IngredientId } from "./catalogue";

/**
 * The severity of a conflict.
 *
 * `BLOCK` — the combination should not be used together. The candidate must
 * not be recommended alongside the product already in the cart.
 *
 * `WARN` — the combination is not dangerous but needs care: layer them
 * separately, alternate nights, or use one at a time.
 */
export type ConflictSeverity = "BLOCK" | "WARN";

/**
 * A single declarative conflict rule.
 *
 * Rules are authored against canonical ingredient IDs or ingredient
 * families. A rule naming `AHA` fires for any product whose tags expand to
 * the `AHA` family, which covers glycolic acid, lactic acid and mandelic
 * acid without needing a rule per molecule.
 */
export type ConflictRule = {
  /** Stable, unique identifier. Appears in logs, in `AdvisorMessage.meta`, and in the UI. */
  readonly id: string;
  /** The first ingredient (or family) in the pair. */
  readonly ingredientA: IngredientId;
  /**
   * The second ingredient (or family).
   *
   * When this equals `ingredientA`, the rule is a *same-ingredient* rule:
   * it fires when two different products both carry that ingredient.
   */
  readonly ingredientB: IngredientId;
  readonly severity: ConflictSeverity;
  /** Short title for the conflict, shown as a heading. */
  readonly title: string;
  /** Plain-language explanation of why the combination is a problem. */
  readonly message: string;
  /** What the customer should actually do about it. */
  readonly remedy: string;
  /**
   * Whether the two actives may be used in the same routine on different
   * days. Used to phrase the remedy accurately.
   */
  readonly spacingAdvice: string;
};

/**
 * Casts a plain string to the branded `IngredientId`.
 *
 * Rule authoring needs to name catalogue entries as literals, so the
 * literals are asserted here rather than scattered through the rules array.
 */
function ing(value: string): IngredientId {
  return value as IngredientId;
}

/**
 * The complete rule set.
 *
 * This array is the safety policy of the platform. It is code, not data, and
 * not an AI prompt — see DECISIONS.md #7 ("The LLM never decides whether a
 * conflict exists").
 *
 * Ordering within this array does not affect evaluation output. The engine
 * sorts results by severity and then by rule ID, so the output order is
 * stable regardless of how the rules are written here.
 */
export const CONFLICT_RULES: readonly ConflictRule[] = [
  // ── Retinoid + exfoliating acid ────────────────────────────────────
  {
    id: "AHA_RETINOL_BLOCK",
    ingredientA: ing("AHA"),
    ingredientB: ing("RETINOID"),
    severity: "BLOCK",
    title: "Do not use AHA exfoliants with retinoids",
    message:
      "AHA exfoliants and retinoids are both strong actives that increase skin sensitivity. Used in the same routine they can cause significant irritation, redness and peeling, and in more sensitive skin they can damage the skin barrier.",
    remedy:
      "Choose one active for now. Keep the retinoid and use a gentle, non-acid cleanser and a rich moisturiser instead — you can add the AHA back into your routine after your skin has adjusted to the retinoid.",
    spacingAdvice:
      "Do not use them on the same day, and do not layer one over the other.",
  },
  {
    id: "BHA_RETINOL_WARN",
    ingredientA: ing("BHA"),
    ingredientB: ing("RETINOID"),
    severity: "WARN",
    title: "Use BHA and retinoids with care",
    message:
      "Salicylic acid and retinoids can both irritate the skin. Separated properly they are commonly used together, but using them in the same routine can leave the skin dry and sensitive.",
    remedy:
      "Alternate them: retinoid on one night, BHA on the next. Apply a moisturiser on both, and stop if your skin stings or flakes.",
    spacingAdvice:
      "Use them on alternate nights, never in the same routine.",
  },
  {
    id: "AHA_BHA_WARN",
    ingredientA: ing("AHA"),
    ingredientB: ing("BHA"),
    severity: "WARN",
    title: "Avoid layering two exfoliating acids",
    message:
      "Two exfoliating acids work on the skin at the same time, which raises the risk of irritation, dryness and sun sensitivity without a clear benefit.",
    remedy:
      "Pick one exfoliating acid and use it consistently. If you want both, alternate them on different days and use a moisturiser on both.",
    spacingAdvice: "Alternate them on different days rather than using both at once.",
  },

  // ── Vitamin C ──────────────────────────────────────────────────────
  {
    id: "VITAMIN_C_DUPLICATE_WARN",
    ingredientA: ing("VITAMIN_C"),
    ingredientB: ing("VITAMIN_C"),
    severity: "WARN",
    title: "You already have vitamin C in your routine",
    message:
      "Using more than one vitamin-C product does not make the effect stronger, and the excess can irritate the skin and waste product. Different vitamin-C forms also stay stable for different amounts of time.",
    remedy:
      "Keep one vitamin-C product — ideally the highest concentration your skin tolerates — and use it in the morning. You can return to the other once your skin is comfortable.",
    spacingAdvice: "Use one vitamin-C product at a time, in the morning.",
  },
  {
    id: "VITAMIN_C_RETINOL_WARN",
    ingredientA: ing("ANTIOXIDANT"),
    ingredientB: ing("RETINOID"),
    severity: "WARN",
    title: "Use vitamin C and retinoids at different times",
    message:
      "Vitamin C and retinoids work on the skin in different ways, and the acidity of many vitamin-C formulas can make retinoids less stable when they are mixed in the same layer.",
    remedy:
      "Use vitamin C in the morning and your retinoid at night. This is the standard way to get the benefit of both without them fighting each other.",
    spacingAdvice: "Use vitamin C in the morning and retinoids at night.",
  },

  // ── Retinoid duplication ───────────────────────────────────────────
  {
    id: "RETINOL_DUPLICATE_WARN",
    ingredientA: ing("RETINOID"),
    ingredientB: ing("RETINOID"),
    severity: "WARN",
    title: "You already have a retinoid in your routine",
    message:
      "Two retinoid products stack their effects on vitamin A, which is a common cause of peeling, redness and sensitivity. The skin does not recover faster because there is more of it.",
    remedy:
      "Use one retinoid, on alternate nights at first. Move to nightly use only once your skin is comfortable, and keep the strength modest if you are new to retinoids.",
    spacingAdvice: "Use one retinoid at a time, starting on alternate nights.",
  },

  // ── Acne actives ───────────────────────────────────────────────────
  {
    id: "BENZOYL_PEROXIDE_AHA_WARN",
    ingredientA: ing("BENZOYL_PEROXIDE"),
    ingredientB: ing("AHA"),
    severity: "WARN",
    title: "Benzoyl peroxide with exfoliating acids",
    message:
      "Benzoyl peroxide and AHA exfoliants both work aggressively on the skin. Together they often cause dryness, stinging and flaking, especially in the first few weeks.",
    remedy:
      "Use benzoyl peroxide as a targeted spot treatment rather than all over, and keep the acid for the days in between. A rich moisturiser will help both.",
    spacingAdvice: "Use benzoyl peroxide as a spot treatment and alternate it with your acid nights.",
  },
  {
    id: "BENZOYL_PEROXIDE_DUPLICATE_WARN",
    ingredientA: ing("BENZOYL_PEROXIDE"),
    ingredientB: ing("BENZOYL_PEROXIDE"),
    severity: "WARN",
    title: "You already have benzoyl peroxide in your routine",
    message:
      "Benzoyl peroxide is effective at the concentrations sold over the counter. Doubling up mostly increases dryness and irritation.",
    remedy:
      "Keep one benzoyl peroxide product, use it consistently for four to six weeks, and let it do its work before adding anything else.",
    spacingAdvice: "Use one benzoyl peroxide product at a time.",
  },

  // ── Preserving the other active ────────────────────────────────────
  {
    id: "RETINOL_AHA_PRESERVATIVE_WARN",
    ingredientA: ing("RETINOID"),
    ingredientB: ing("PRESERVATIVE"),
    severity: "WARN",
    title: "Retinoid with a second active formula",
    message:
      "A retinoid formula and an active formula each carry their own preservative system. Layering two actives raises the chance of irritation, and the retinoid in particular is easily destabilised by a more acidic layer on top.",
    remedy:
      "Separate the two actives across the day — one in the morning and one at night — and introduce the second one only once the first has settled.",
    spacingAdvice: "Separate the two actives between morning and night.",
  },
  {
    id: "HYDROQUINONE_AHA_WARN",
    ingredientA: ing("HYDROQUINONE"),
    ingredientB: ing("AHA"),
    severity: "WARN",
    title: "Hydroquinone with exfoliating acids",
    message:
      "Hydroquinone is already a potent active, and adding an exfoliating acid on top increases irritation. Hydroquinone also works best in a simple routine, away from other actives.",
    remedy:
      "Use hydroquinone on its own at night for the period your doctor has recommended, and pause your acid during that time.",
    spacingAdvice: "Keep hydroquinone on its own at night, away from your acid nights.",
  },
  {
    id: "VITAMIN_C_BENZOYL_PEROXIDE_WARN",
    ingredientA: ing("ANTIOXIDANT"),
    ingredientB: ing("BENZOYL_PEROXIDE"),
    severity: "WARN",
    title: "Vitamin C with benzoyl peroxide",
    message:
      "Benzoyl peroxide can oxidise vitamin C on contact, which reduces how much of the vitamin C is still active when it reaches your skin.",
    remedy:
      "Use vitamin C in the morning and benzoyl peroxide at night, and keep them apart on the shelf as well as in the routine.",
    spacingAdvice: "Use vitamin C in the morning and benzoyl peroxide at night.",
  },

  // ── Hydration support ──────────────────────────────────────────────
  {
    id: "HUMECTANT_OVERLAY_WARN",
    ingredientA: ing("HYDRATOR"),
    ingredientB: ing("RETINOID"),
    severity: "WARN",
    title: "Support hydration while you use a retinoid",
    message:
      "Retinoids increase water loss through the skin barrier. Humectants are safe to use with them and are the best way to reduce peeling, but too many at once can leave the skin feeling swollen or dewy.",
    remedy:
      "One humectant serum is enough alongside your retinoid. Follow it with a moisturiser to seal it in, and introduce it before the retinoid if your skin feels tight.",
    spacingAdvice: "Use one humectant serum, then a moisturiser on top.",
  },
];

/**
 * A lookup of rules by ID.
 */
export const CONFLICT_RULES_BY_ID: ReadonlyMap<string, ConflictRule> = new Map(
  CONFLICT_RULES.map((rule) => [rule.id, rule]),
);
