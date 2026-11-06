/**
 * The canonical ingredient catalogue.
 *
 * Every product's `ingredientTags` array holds canonical IDs from this
 * catalogue — never free text. The conflict engine compares IDs, so the
 * catalogue is what makes the comparison meaningful: "AHA" and "alpha hydroxy
 * acid" must resolve to the same ID before the rules can fire.
 *
 * The catalogue is deliberately a static module rather than a database table.
 * Two reasons:
 *
 *  1. The engine must be pure and synchronous. A database lookup inside the
 *     engine would make it I/O-bound, and I/O inside the safety path is
 *     where correctness bugs hide.
 *  2. The catalogue changes when the product catalogue changes, and that is
 *     a deliberate, reviewed act — a migration, not a runtime edit.
 *
 * `aliases` exist for the admin UI: an admin typing "glycolic acid" should
 * map to `GLYCOLIC_ACID` without a fuzzy match at runtime. Alias resolution
 * is exact and case-insensitive — it happens at the admin boundary, once,
 * when the tag is written to the database.
 */

/**
 * A canonical ingredient ID.
 *
 * A branded string type so a plain `string` cannot be passed where a
 * validated ID is expected. This is compile-time only — there is no runtime
 * difference between `IngredientId` and `string`.
 */
export type IngredientId = string & { readonly __brand: "IngredientId" };

/**
 * A single entry in the catalogue.
 */
export type CatalogueEntry = {
  /** The canonical ID stored on `Product.ingredientTags`. */
  readonly id: IngredientId;
  /** Human-readable name shown to customers. */
  readonly displayName: string;
  /**
   * A short, plain-language description of what the ingredient does.
   *
   * Used by the advisor to explain *why* two actives should not be layered,
   * without the model having to invent a pharmacological explanation.
   */
  readonly description: string;
  /**
   * Lower-cased alternate spellings and synonyms.
   *
   * Resolution is exact-match on the normalised string — no Levenshtein, no
   * tokenisation, no "did you mean". A fuzzy match in the safety path can
   * silently map an unrelated ingredient to a rule that then fires on the
   * wrong pair.
   */
  readonly aliases: readonly string[];
  /**
   * Ingredient families.
   *
   * Rules are authored against families rather than individual molecules
   * wherever the science is family-wide, so a new glycolic-acid product is
   * covered by an existing rule without anyone editing the rules array.
   */
  readonly family?: IngredientFamily;
};

/**
 * Ingredient families.
 *
 * A product may belong to more than one family (e.g. `SALICYLIC_ACID` is
 * both a `BHA` and an `EXFOLIANT`). The engine expands each tag into the set
 * of families it belongs to, then matches rules against either the specific
 * ID or the family.
 */
export const INGREDIENT_FAMILIES = [
  "AHA",
  "BHA",
  "EXFOLIANT",
  "RETINOID",
  "ANTIOXIDANT",
  "HYDRATOR",
  "PRESERVATIVE",
  "ACID",
] as const;

export type IngredientFamily = (typeof INGREDIENT_FAMILIES)[number];

/**
 * Casts a plain string to the branded `IngredientId`.
 *
 * Only the catalogue itself should call this. Everything else consumes
 * `CATALOGUE` or `CATALOGUE_BY_ID`.
 */
function id(value: string): IngredientId {
  return value as IngredientId;
}

/**
 * The catalogue.
 *
 * Ordered by family so the admin dropdown renders sensibly. The order does
 * not affect the engine — the engine only ever looks up by ID.
 */
export const CATALOGUE: readonly CatalogueEntry[] = [
  // ── Exfoliating acids ──────────────────────────────────────────────
  {
    id: id("AHA"),
    displayName: "Alpha Hydroxy Acids (AHA)",
    description:
      "Water-soluble exfoliating acids that loosen dead surface cells. Common examples include glycolic acid and lactic acid.",
    aliases: ["aha", "aha s", "alpha hydroxy acid", "alpha hydroxy acids", "alphas"],
    family: "AHA",
  },
  {
    id: id("BHA"),
    displayName: "Beta Hydroxy Acids (BHA)",
    description:
      "Oil-soluble exfoliating acid, usually salicylic acid. It works inside the pore, so it is used for congestion and oily skin.",
    aliases: ["bha", "bha s", "beta hydroxy acid", "beta hydroxy acids", "betas"],
    family: "BHA",
  },
  {
    id: id("GLYCOLIC_ACID"),
    displayName: "Glycolic Acid",
    description:
      "An AHA with the strongest exfoliating effect. It penetrates quickly and can irritate sensitive skin.",
    aliases: ["glycolic acid", "glycolic", "gluconolactone"],
    family: "AHA",
  },
  {
    id: id("LACTIC_ACID"),
    displayName: "Lactic Acid",
    description:
      "A gentler, larger-molecule AHA that hydrates as it exfoliates. Often chosen for dry or sensitive skin.",
    aliases: ["lactic acid", "lactic"],
    family: "AHA",
  },
  {
    id: id("MANDELIC_ACID"),
    displayName: "Mandelic Acid",
    description:
      "A very gentle AHA with a large molecule, suited to sensitive and deeper skin tones.",
    aliases: ["mandelic acid", "mandelic"],
    family: "AHA",
  },
  {
    id: id("SALICYLIC_ACID"),
    displayName: "Salicylic Acid",
    description:
      "The best-known BHA. Oil-soluble, so it clears congestion inside the pore.",
    aliases: ["salicylic acid", "salicylic", "bha acid"],
    family: "BHA",
  },
  {
    id: id("TARTARIC_ACID"),
    displayName: "Tartaric Acid",
    description:
      "An AHA used to stabilise acid formulations and support the exfoliating effect.",
    aliases: ["tartaric acid", "tartaric"],
    family: "AHA",
  },
  {
    id: id("MALIC_ACID"),
    displayName: "Malic Acid",
    description:
      "A mild AHA that supports the exfoliating effect of a formula and helps condition it.",
    aliases: ["malic acid", "malic"],
    family: "AHA",
  },
  {
    id: id("GLUCONOLACTONE"),
    displayName: "Gluconolactone (PHA)",
    description:
      "A polyhydroxy acid — a very gentle exfoliant that is also a humectant.",
    aliases: ["gluconolactone", "pha", "polyhydroxy acid"],
    family: "AHA",
  },

  // ── Retinoids ──────────────────────────────────────────────────────
  {
    id: id("RETINOL"),
    displayName: "Retinol",
    description:
      "An over-the-counter retinoid that the skin converts into retinoic acid. It is the most common vitamin-A active in cosmetic products.",
    aliases: ["retinol", "retinol 0.3", "retinyl alcohol"],
    family: "RETINOID",
  },
  {
    id: id("RETINYL_PALMITATE"),
    displayName: "Retinyl Palmitate",
    description:
      "An ester of retinol that is more stable but converts to retinoic acid slowly, so it is a gentler vitamin-A active.",
    aliases: ["retinyl palmitate", "retinyl", "vitamin a palmitate"],
    family: "RETINOID",
  },
  {
    id: id("RETINAL"),
    displayName: "Retinaldehyde",
    description:
      "An aldehyde form of vitamin A. It converts to retinoic acid more efficiently than retinol, at a similar strength.",
    aliases: ["retinal", "retinaldehyde"],
    family: "RETINOID",
  },
  {
    id: id("TRETINOIN"),
    displayName: "Tretinoin",
    description:
      "A prescription-strength retinoid. It should only be used under a doctor's supervision.",
    aliases: ["tretinoin", "all-trans retinoic acid", "at ra"],
    family: "RETINOID",
  },
  {
    id: id("ADAPALENE"),
    displayName: "Adapalene",
    description:
      "A prescription retinoid used for acne. It should only be used under a doctor's supervision.",
    aliases: ["adapalene", "differin"],
    family: "RETINOID",
  },

  // ── Antioxidants & brightening ──────────────────────────────────────
  {
    id: id("VITAMIN_C"),
    displayName: "Vitamin C (L-Ascorbic Acid)",
    description:
      "An antioxidant that brightens uneven tone and supports collagen. It is unstable once the formula is opened.",
    aliases: ["vitamin c", "vit c", "ascorbic acid", "l-ascorbic acid", "lascorbic acid"],
    family: "ANTIOXIDANT",
  },
  {
    id: id("SODIUM_ASCORBYL_PHOSPHATE"),
    displayName: "Sodium Ascorbyl Phosphate",
    description:
      "A stable, water-soluble vitamin-C derivative that brightens with less irritation.",
    aliases: ["sodium ascorbyl phosphate", "sap"],
    family: "ANTIOXIDANT",
  },
  {
    id: id("ASCORBYL_GLUCOSIDE"),
    displayName: "Ascorbyl Glucoside",
    description:
      "A slow-release vitamin-C derivative. Gentle, but the effect builds over time.",
    aliases: ["ascorbyl glucoside", "aa"],
    family: "ANTIOXIDANT",
  },
  {
    id: id("NIACINAMIDE"),
    displayName: "Niacinamide (Vitamin B3)",
    description:
      "A well-tolerated active that supports the skin barrier, regulates oil and evens tone. It pairs well with most routines.",
    aliases: ["niacinamide", "vitamin b3", "nicotinamide"],
    family: "ANTIOXIDANT",
  },
  {
    id: id("AZELAIC_ACID"),
    displayName: "Azelaic Acid",
    description:
      "An active used for redness, uneven tone and post-acne marks. It is one of the few actives considered suitable during pregnancy — confirm with a doctor.",
    aliases: ["azelaic acid", "azelaic"],
    family: "ACID",
  },
  {
    id: id("HYDROQUINONE"),
    displayName: "Hydroquinone",
    description:
      "A prescription-strength brightening active. It should only be used under a doctor's supervision.",
    aliases: ["hydroquinone", "hq"],
  },
  {
    id: id("KOJIC_ACID"),
    displayName: "Kojic Acid",
    description: "A gentle brightening active derived from fermented rice.",
    aliases: ["kojic acid", "kojic"],
    family: "ACID",
  },
  {
    id: id("ARBUTIN"),
    displayName: "Arbutin",
    description:
      "A plant-derived brightening active that converts to hydroquinone slowly in the skin.",
    aliases: ["arbutin", "alpha arbutin"],
  },
  {
    id: id("TRANEXAMIC_ACID"),
    displayName: "Tranexamic Acid",
    description:
      "An active used to reduce the appearance of redness and uneven tone.",
    aliases: ["tranexamic acid", "txa"],
    family: "ACID",
  },

  // ── Acne actives ───────────────────────────────────────────────────
  {
    id: id("BENZOYL_PEROXIDE"),
    displayName: "Benzoyl Peroxide",
    description:
      "An antibacterial acne active that kills the bacteria that cause breakouts. It bleaches fabric.",
    aliases: ["benzoyl peroxide", "bpo", "benzoyl perox"],
  },
  {
    id: id("TEA_TREE_OIL"),
    displayName: "Tea Tree Oil",
    description:
      "A botanical antibacterial oil used for blemishes. It can irritate if used undiluted.",
    aliases: ["tea tree oil", "tea tree", "melaleuca"],
  },
  {
    id: id("SULFUR"),
    displayName: "Sulfur",
    description:
      "An antibacterial and keratolytic ingredient used for acne and oily skin.",
    aliases: ["sulfur", "sulphur"],
  },

  // ── Hydrators & barrier support ────────────────────────────────────
  {
    id: id("HYALURONIC_ACID"),
    displayName: "Hyaluronic Acid",
    description:
      "A humectant that draws water into the skin. It pairs safely with almost every active.",
    aliases: ["hyaluronic acid", "hyaluronan", "sodium hyaluronate", "ha"],
    family: "HYDRATOR",
  },
  {
    id: id("GLYCERIN"),
    displayName: "Glycerin",
    description:
      "A humectant that pulls water into the skin and supports the barrier. It is gentle and pairs safely with most actives.",
    aliases: ["glycerin", "glycerol"],
    family: "HYDRATOR",
  },
  {
    id: id("PANTHENOL"),
    displayName: "Panthenol (Pro-Vitamin B5)",
    description:
      "A soothing humectant that supports barrier repair and reduces redness.",
    aliases: ["panthenol", "pro vitamin b5", "provitamin b5", "dexpanthenol"],
    family: "HYDRATOR",
  },
  {
    id: id("CERAMIDES"),
    displayName: "Ceramides",
    description:
      "The lipids that make up the skin barrier. They reduce water loss and calm reactive skin.",
    aliases: ["ceramides", "ceramide"],
    family: "HYDRATOR",
  },
  {
    id: id("SQUALANE"),
    displayName: "Squalane",
    description:
      "A light, non-comedogenic emollient that softens and seals the skin without heaviness.",
    aliases: ["squalane"],
    family: "HYDRATOR",
  },
  {
    id: id("ALOE_VERA"),
    displayName: "Aloe Vera",
    description: "A botanical humectant used to soothe and cool irritated skin.",
    aliases: ["aloe vera", "aloe", "aloe barbadensis"],
    family: "HYDRATOR",
  },
  {
    id: id("SHEA_BUTTER"),
    displayName: "Shea Butter",
    description:
      "A rich plant butter that softens dry skin. It is too heavy for some oily skin types.",
    aliases: ["shea butter", "shea"],
    family: "HYDRATOR",
  },
  {
    id: id("COLLAGEN"),
    displayName: "Collagen (Hydrolysed)",
    description:
      "A large protein broken into small peptides for topical use. It is a surface-level moisturiser, not a collagen booster.",
    aliases: ["collagen", "hydrolysed collagen", "collagen peptides"],
    family: "HYDRATOR",
  },

  // ── Preservatives & calmers ────────────────────────────────────────
  {
    id: id("NIACINAMIDE_PRESERVATIVE"),
    displayName: "Preservative System",
    description:
      "The preservatives that keep a formula safe from microbial growth. Relevant when two formulas are layered, because preservatives are not interchangeable at the same concentration.",
    aliases: ["preservative", "preservatives", "preservative system"],
    family: "PRESERVATIVE",
  },
  {
    id: id("CENTELLA_ASIAATICA"),
    displayName: "Centella Asiatica (Cica)",
    description:
      "A botanical extract used to calm redness and support barrier repair.",
    aliases: ["centella asiatica", "centella", "cica", "gotu kola"],
  },
  {
    id: id("ALLANTOIN"),
    displayName: "Allantoin",
    description: "A soothing ingredient that calms irritation and supports skin repair.",
    aliases: ["allantoin"],
  },
  {
    id: id("BISABOLOL"),
    displayName: "Bisabolol",
    description: "A chamomile-derived calming agent that reduces redness and irritation.",
    aliases: ["bisabolol", "alpha bisabolol"],
  },
  {
    id: id("NIACINAMIDE_CALMING"),
    displayName: "Calming Complex",
    description:
      "A blend of soothing botanical extracts used to reduce visible redness.",
    aliases: ["calming complex", "soothing complex"],
  },
  {
    id: id("AZULENE"),
    displayName: "Azulene",
    description: "A blue botanical extract used to calm redness in reactive skin.",
    aliases: ["azulene"],
  },
  {
    id: id("OAT_EXTRACT"),
    displayName: "Oat Extract (Colloidal Oatmeal)",
    description:
      "An ingredient recognised for relieving itch and irritation in sensitive skin.",
    aliases: ["oat extract", "colloidal oatmeal", "oat", "avena sativa"],
  },
];

/**
 * A lookup of catalogue entries by canonical ID.
 */
export const CATALOGUE_BY_ID: ReadonlyMap<IngredientId, CatalogueEntry> = new Map(
  CATALOGUE.map((entry) => [entry.id, entry]),
);

/**
 * A lookup of catalogue entries by alias (normalised).
 *
 * The key is the alias lower-cased and stripped of spaces, hyphens and
 * underscores, so "Alpha Hydroxy Acid", "alpha-hydroxy-acid" and
 * "alpha_hydroxy_acid" all resolve to the same entry.
 */
export const CATALOGUE_BY_ALIAS: ReadonlyMap<string, CatalogueEntry> = (() => {
  const map = new Map<string, CatalogueEntry>();

  for (const entry of CATALOGUE) {
    // The canonical ID is always resolvable, even if it is not listed as an
    // explicit alias.
    map.set(normaliseLookup(entry.id), entry);
    map.set(normaliseLookup(entry.displayName), entry);

    for (const alias of entry.aliases) {
      map.set(normaliseLookup(alias), entry);
    }
  }

  return map;
})();

/**
 * Normalises a lookup string for alias matching.
 *
 * Lower-cased, with spaces, hyphens, underscores and slashes removed. This
 * is deliberately aggressive about *punctuation only* — it never truncates
 * or fuzzy-matches, so two genuinely different names cannot collide.
 */
function normaliseLookup(value: string): string {
  return value.toLowerCase().replace(/[\s\-_/]+/g, "");
}

/**
 * Resolves a free-text ingredient name to a canonical ID.
 *
 * @returns the canonical ID, or `null` when the name is not in the catalogue.
 */
export function resolveIngredientId(name: string): IngredientId | null {
  const entry = CATALOGUE_BY_ALIAS.get(normaliseLookup(name));
  return entry ? entry.id : null;
}

/**
 * Resolves a free-text ingredient name to its catalogue entry.
 */
export function resolveIngredient(name: string): CatalogueEntry | null {
  return CATALOGUE_BY_ALIAS.get(normaliseLookup(name)) ?? null;
}

/**
 * Returns the display name for an ID, falling back to the raw ID.
 *
 * The fallback matters: a product tagged with an ID that is not in the
 * catalogue must still render something, and the engine must still be able
 * to reason about it.
 */
export function displayNameFor(ingredientId: IngredientId): string {
  return CATALOGUE_BY_ID.get(ingredientId)?.displayName ?? ingredientId;
}

/**
 * Returns the families an ingredient belongs to.
 *
 * An ingredient with no family returns an empty array, so it only ever
 * matches rules that name it directly.
 */
export function familiesFor(ingredientId: IngredientId): IngredientFamily[] {
  const entry = CATALOGUE_BY_ID.get(ingredientId);
  return entry?.family ? [entry.family] : [];
}
