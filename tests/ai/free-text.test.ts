import { describe, expect, it } from "vitest";

import {
  NO_RECOMMENDATIONS,
  parseFreeTextReply,
  parseFunctionCallIds,
  parseNamedProductIds,
  RECOMMENDATION_MARKER,
} from "@/lib/ai/free-text";

/**
 * The free-text parser.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The advisor no longer answers in JSON. It answers in prose, and the
 * product ids travel on a side channel: a marker line in the prose, and
 * a function call in the Gemini case.
 *
 * That makes this parser the seam where an untrusted model output
 * becomes structured data. Two properties matter, and they pull in
 * opposite directions:
 *
 *   1. **Nothing reaches the customer that should not.** The marker is
 *      removed from the prose — always, wherever it appears.
 *   2. **Nothing reaches the recommendation list that should not.** An
 *      entry that is not a candidate is dropped.
 *
 * The parser extracts; it never widens. The service layer still
 * validates against the allow-list — these tests are about the
 * extraction step.
 */

/**
 * The candidates the model is allowed to name.
 */
const CANDIDATES = [
  { id: "prod_niacinamide", name: "Niacinamide 10% Serum" },
  { id: "prod_cleanser", name: "Gentle Gel Cleanser" },
  { id: "prod_spf", name: "Daily Sunscreen SPF 50" },
];

describe("parseFreeTextReply", () => {
  describe("the marker", () => {
    it("reads the ids off the marker line", () => {
      const parsed = parseFreeTextReply(
        "Your skin looks oily, so start with the cleanser.\n\n[RECOMMENDED: prod_cleanser, prod_niacinamide]",
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual([
        "prod_cleanser",
        "prod_niacinamide",
      ]);
      expect(parsed.hadMarker).toBe(true);
    });

    it("removes the marker from the prose the customer sees", () => {
      const parsed = parseFreeTextReply(
        "Here is what I would start with.\n\n[RECOMMENDED: prod_cleanser]",
        CANDIDATES,
      );

      expect(parsed.content).toBe("Here is what I would start with.");
      expect(parsed.content).not.toContain(RECOMMENDATION_MARKER);
    });

    it("removes the marker wherever it appears, not just at the end", () => {
      // A model that mentions the convention mid-reply must not leave it
      // visible to the customer.
      const parsed = parseFreeTextReply(
        "[RECOMMENDED: prod_spf] I would add sunscreen in the morning.",
        CANDIDATES,
      );

      expect(parsed.content).toBe("I would add sunscreen in the morning.");
      expect(parsed.productIds).toEqual(["prod_spf"]);
    });

    it("treats 'none' as no recommendations", () => {
      const parsed = parseFreeTextReply(
        `Hello! Tell me about your skin.\n\n[RECOMMENDED: ${NO_RECOMMENDATIONS}]`,
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual([]);
      expect(parsed.hadMarker).toBe(true);
    });

    it("treats 'none' in any case as no recommendations", () => {
      const parsed = parseFreeTextReply(
        "[RECOMMENDED: NONE]",
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual([]);
    });

    it("survives the absence of the marker", () => {
      // The model ignoring the convention is a normal outcome, not an
      // error. The prose is what matters.
      const parsed = parseFreeTextReply(
        "Hello! What is your skin type?",
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual([]);
      expect(parsed.hadMarker).toBe(false);
      expect(parsed.content).toBe("Hello! What is your skin type?");
    });

    it("drops an id that was never a candidate", () => {
      const parsed = parseFreeTextReply(
        "[RECOMMENDED: prod_cleanser, prod_invented]",
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual(["prod_cleanser"]);
    });
  });

  describe("the entries", () => {
    it("accepts an id wrapped in quotes", () => {
      const parsed = parseFreeTextReply(
        '[RECOMMENDED: "prod_cleanser"]',
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual(["prod_cleanser"]);
    });

    it("accepts an id wrapped in backticks", () => {
      const parsed = parseFreeTextReply(
        "[RECOMMENDED: `prod_cleanser`]",
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual(["prod_cleanser"]);
    });

    it("accepts an id with trailing punctuation", () => {
      const parsed = parseFreeTextReply(
        "[RECOMMENDED: prod_cleanser.]",
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual(["prod_cleanser"]);
    });

    it("recovers the id when the model wrote the product's name", () => {
      // A model with the candidate list in front of it will sometimes
      // answer with the title instead of the id.
      const parsed = parseFreeTextReply(
        "[RECOMMENDED: Daily Sunscreen SPF 50]",
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual(["prod_spf"]);
    });

    it("does not guess when a name is ambiguous", () => {
      // Two candidates with the same title would make the
      // recommendation a coin flip. Ambiguity is dropped.
      const parsed = parseFreeTextReply(
        "[RECOMMENDED: Duo]",
        [
          { id: "prod_a", name: "Duo" },
          { id: "prod_b", name: "Duo" },
        ],
      );

      expect(parsed.productIds).toEqual([]);
    });

    it("removes duplicates but keeps the order", () => {
      const parsed = parseFreeTextReply(
        "[RECOMMENDED: prod_spf, prod_cleanser, prod_spf]",
        CANDIDATES,
      );

      expect(parsed.productIds).toEqual(["prod_spf", "prod_cleanser"]);
    });

    it("ignores an empty marker", () => {
      const parsed = parseFreeTextReply("[RECOMMENDED: ]", CANDIDATES);

      expect(parsed.productIds).toEqual([]);
      expect(parsed.hadMarker).toBe(true);
    });
  });

  describe("the prose", () => {
    it("keeps the model's own paragraph breaks", () => {
      const parsed = parseFreeTextReply(
        "First paragraph.\n\nSecond paragraph.",
        CANDIDATES,
      );

      expect(parsed.content).toBe("First paragraph.\n\nSecond paragraph.");
    });

    it("tidies the gap the marker left behind", () => {
      const parsed = parseFreeTextReply(
        "Here is my advice.\n\n[RECOMMENDED: prod_cleanser]\n",
        CANDIDATES,
      );

      expect(parsed.content).toBe("Here is my advice.");
    });

    it("returns an empty string for an empty reply", () => {
      const parsed = parseFreeTextReply("", CANDIDATES);

      expect(parsed.content).toBe("");
      expect(parsed.productIds).toEqual([]);
    });
  });
});

describe("parseFunctionCallIds", () => {
  it("reads the ids off a structured argument list", () => {
    const ids = parseFunctionCallIds(
      { productIds: ["prod_cleanser", "prod_niacinamide"] },
      CANDIDATES,
    );

    expect(ids).toEqual(["prod_cleanser", "prod_niacinamide"]);
  });

  it("accepts the alternative argument names", () => {
    expect(parseFunctionCallIds({ ids: ["prod_cleanser"] }, CANDIDATES)).toEqual(
      ["prod_cleanser"],
    );
    expect(
      parseFunctionCallIds({ product_ids: ["prod_cleanser"] }, CANDIDATES),
    ).toEqual(["prod_cleanser"]);
    expect(
      parseFunctionCallIds({ products: ["prod_cleanser"] }, CANDIDATES),
    ).toEqual(["prod_cleanser"]);
  });

  it("accepts a comma-separated string", () => {
    const ids = parseFunctionCallIds(
      { productIds: "prod_cleanser, prod_spf" },
      CANDIDATES,
    );

    expect(ids).toEqual(["prod_cleanser", "prod_spf"]);
  });

  it("returns nothing when the model recommended nothing", () => {
    expect(parseFunctionCallIds({ productIds: [] }, CANDIDATES)).toEqual([]);
  });

  it("drops an id that was never a candidate", () => {
    const ids = parseFunctionCallIds(
      { productIds: ["prod_cleanser", "prod_invented"] },
      CANDIDATES,
    );

    expect(ids).toEqual(["prod_cleanser"]);
  });

  it("survives arguments that are not an object", () => {
    expect(parseFunctionCallIds(null, CANDIDATES)).toEqual([]);
    expect(parseFunctionCallIds("nonsense", CANDIDATES)).toEqual([]);
    expect(parseFunctionCallIds(undefined, CANDIDATES)).toEqual([]);
  });

  it("survives arguments with no id field at all", () => {
    expect(parseFunctionCallIds({ note: "hello" }, CANDIDATES)).toEqual([]);
  });

  it("ignores entries that are not strings", () => {
    const ids = parseFunctionCallIds(
      { productIds: ["prod_cleanser", 42, null] },
      CANDIDATES,
    );

    expect(ids).toEqual(["prod_cleanser"]);
  });

  it("recovers the id when the model wrote the product's name", () => {
    const ids = parseFunctionCallIds(
      { productIds: ["Niacinamide 10% Serum"] },
      CANDIDATES,
    );

    expect(ids).toEqual(["prod_niacinamide"]);
  });
});

/**
 * The name-recovery channel.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The marker line was measured being dropped in roughly a third of live
 * conversation turns, and a dropped marker means the shop attaches no
 * product cards at all. The third channel is the one that saves it: the
 * model **names** the products it recommends, and the name is in the
 * candidate list.
 *
 * But a name is weaker evidence than a marker. A model can mention a
 * product without recommending it — to warn against it, for instance.
 * So the rules are narrow on purpose, and these tests are what keep
 * them narrow.
 */
describe("parseNamedProductIds", () => {
  it("finds a product the prose names", () => {
    const ids = parseNamedProductIds(
      "Start with the Niacinamide 10% Serum for your oily skin.",
      CANDIDATES,
    );

    expect(ids).toEqual(["prod_niacinamide"]);
  });

  it("finds every product the prose names", () => {
    const ids = parseNamedProductIds(
      "Use the Gentle Gel Cleanser first, then the Niacinamide 10% Serum.",
      CANDIDATES,
    );

    expect(ids).toEqual(["prod_cleanser", "prod_niacinamide"]);
  });

  it("ignores a product the prose does not name", () => {
    const ids = parseNamedProductIds(
      "A gentle foaming cleanser works well for oily skin.",
      CANDIDATES,
    );

    expect(ids).toEqual([]);
  });

  it("skips the excluded ids", () => {
    /*
     * A conflicted product is one the model has been asked to warn
     * about — so naming it is the warning, not a recommendation.
     */
    const ids = parseNamedProductIds(
      "Skip the Niacinamide 10% Serum for now — use the Gentle Gel Cleanser.",
      CANDIDATES,
      ["prod_niacinamide"],
    );

    expect(ids).toEqual(["prod_cleanser"]);
  });

  it("matches a name regardless of case", () => {
    const ids = parseNamedProductIds(
      "try the niacinamide 10% serum",
      CANDIDATES,
    );

    expect(ids).toEqual(["prod_niacinamide"]);
  });

  it("returns nothing for empty prose", () => {
    expect(parseNamedProductIds("", CANDIDATES)).toEqual([]);
  });

  it("returns nothing when there are no candidates", () => {
    expect(
      parseNamedProductIds("Try the Niacinamide 10% Serum.", []),
    ).toEqual([]);
  });

  it("ignores a name too short to identify a product", () => {
    const ids = parseNamedProductIds("Try the SPF.", [{ id: "prod_x", name: "SPF" }]);

    expect(ids).toEqual([]);
  });
});
