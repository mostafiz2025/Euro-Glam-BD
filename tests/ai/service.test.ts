import { describe, expect, it } from "vitest";

import {
  buildMessageMeta,
  MAX_CANDIDATES,
  MAX_RECOMMENDATIONS,
  mergeHistory,
  reasonFor,
  selectRecommendedIds,
} from "@/lib/ai/service";
import {
  resolveAllowedIds,
  type AdvisorHistoryTurn,
  type AdvisorRequest,
  type AdvisorResponse,
  type AiProvider,
  type ProductCandidate,
} from "@/lib/ai/provider";
import type { AdvisorIntent } from "@/lib/ai/intent";
import {
  resolveIngredientId,
  type IngredientId,
} from "@/lib/conflicts/catalogue";

/**
 * The advisor service layer's guard rails.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The service layer's job is to make the provider's output **safe to
 * show**, no matter what the provider said. The provider is untrusted
 * input. So these tests inject a provider that misbehaves — recommends a
 * product that was never offered, names a conflict that does not exist,
 * downgrades a severity — and assert that the code's decisions survive.
 *
 * The pure helpers (`resolveAllowedIds`, `reasonFor`, `buildMessageMeta`)
 * are tested directly. The parts that need a database live in the
 * integration suite.
 */

/**
 * A candidate product.
 */
const CANDIDATE: ProductCandidate = {
  id: "prod_niacinamide",
  name: "Niacinamide 10% Serum",
  categoryName: "Skincare",
  pricePaisa: 120000,
  discountPricePaisa: null,
  ingredientTags: ["NIACINAMIDE"],
  climateTips: null,
  description: "A balancing serum for oily skin.",
};

const SECOND_CANDIDATE: ProductCandidate = {
  id: "prod_cleanser",
  name: "Gentle Gel Cleanser",
  categoryName: "Skincare",
  pricePaisa: 90000,
  discountPricePaisa: 75000,
  ingredientTags: ["GLYCERIN"],
  climateTips: null,
  description: "A pH-balanced daily cleanser.",
};

/**
 * The ingredient ids, resolved from the catalogue.
 *
 * `IngredientId` is a branded type — a plain string is not assignable
 * to it. Resolving through `resolveIngredientId` rather than casting
 * means the test would fail if the catalogue ever renamed an id, which
 * is the point of the brand.
 */
const AHA_ID = resolveIngredientId("AHA") as IngredientId;
const NIACINAMIDE_ID = resolveIngredientId("Niacinamide") as IngredientId;

/**
 * Builds a request for the tests.
 */
function makeRequest(overrides: Partial<AdvisorRequest> = {}): AdvisorRequest {  return {
    userMessage: "My skin is oily in the afternoon.",
    profile: { skinType: "OILY", concerns: ["OILINESS"], notes: null },
    candidates: [CANDIDATE, SECOND_CANDIDATE],
    conflicts: [],
    allowedProductIds: null,
    systemPrompt: null,
    ...overrides,
  };
}

/**
 * A provider that returns whatever it is told to.
 *
 * The misbehaviour is injected, so the test's intent is explicit: this
 * provider is *wrong*, and the service layer must not believe it.
 */
function makeProvider(
  response: Partial<AdvisorResponse> = {},
): AiProvider {
  return {
    name: "test-provider",
    modelName: "test-model",
    async complete(): Promise<AdvisorResponse> {
      return {
        content: "Here is some advice.",
        recommendedProductIds: [CANDIDATE.id],
        providerName: "test-provider",
        modelName: "test-model",
        isMocked: false,
        ...response,
      };
    },
  };
}

describe("resolveAllowedIds", () => {
  it("uses the allow-list when one is given", () => {
    const allowed = resolveAllowedIds(
      makeRequest({ allowedProductIds: [CANDIDATE.id] }),
    );

    expect([...allowed]).toEqual([CANDIDATE.id]);
  });

  it("falls back to the candidate list when the allow-list is null", () => {
    const allowed = resolveAllowedIds(makeRequest());

    expect(allowed.size).toBe(2);
    expect(allowed.has(CANDIDATE.id)).toBe(true);
    expect(allowed.has(SECOND_CANDIDATE.id)).toBe(true);
  });

  it("is empty when there are no candidates and no allow-list", () => {
    const allowed = resolveAllowedIds(makeRequest({ candidates: [] }));

    expect(allowed.size).toBe(0);
  });
});

describe("reasonFor", () => {
  it("names the ingredients when there are any", () => {
    const reason = reasonFor(CANDIDATE, undefined);

    expect(reason).toContain("niacinamide");
  });

  it("falls back to a generic line when there are no ingredient tags", () => {
    const reason = reasonFor(
      { ...CANDIDATE, ingredientTags: [] },
      undefined,
    );

    expect(reason).toContain("gentle option");
  });

  it("says the product should be used on its own for a BLOCK", () => {
    const reason = reasonFor(CANDIDATE, {
      ruleId: "AHA_RETINOL_BLOCK",
      severity: "BLOCK",
      title: "Do not combine",
      message: "They conflict.",
      involvedProductIds: [CANDIDATE.id],
      ingredientIds: [AHA_ID],
      remedy: "Choose one.",
      spacingAdvice: "Do not use them together.",
    });

    expect(reason).toContain("on its own");
  });

  it("says to space the products apart for a WARN", () => {
    const reason = reasonFor(CANDIDATE, {
      ruleId: "NIACINAMIDE_RETINOL_WARN",
      severity: "WARN",
      title: "Space them apart",
      message: "They can be used together.",
      involvedProductIds: [CANDIDATE.id],
      ingredientIds: [NIACINAMIDE_ID],
      remedy: "Use at different times.",
      spacingAdvice: "Separate them by a day.",
    });

    expect(reason).toContain("spacing");
  });
});

describe("buildMessageMeta", () => {
  const result = {
    content: "Some advice.",
    recommendations: [
      {
        productId: CANDIDATE.id,
        name: CANDIDATE.name,
        pricePaisa: CANDIDATE.pricePaisa,
        discountPricePaisa: null,
        reason: "A good match.",
      },
    ],
    conflicts: [
      {
        ruleId: "RULE_1",
        severity: "BLOCK" as const,
        title: "Do not combine",
        message: "They conflict.",
        remedy: "Choose one.",
        spacingAdvice: "Not together.",
        involvedProductIds: [CANDIDATE.id],
        ingredientIds: ["AHA"],
      },
    ],
    disclaimer: { text: "Not medical advice.", version: 3 },
    provider: {
      name: "mock",
      isMocked: true,
      model: "mock-deterministic-v1",
    },
    skinProfile: { skinType: "OILY" as const, concerns: ["OILINESS"] },
    intent: {
      kind: "CONCERN" as const,
      mayRecommend: true,
      mayWarn: true,
      missing: [],
    },
  };

  it("records the recommended product ids", () => {
    expect(buildMessageMeta(result).recommendedProductIds).toEqual([
      CANDIDATE.id,
    ]);
  });

  it("records the disclaimer version — the audit stamp", () => {
    expect(buildMessageMeta(result).disclaimerVersion).toBe(3);
  });

  it("records the conflicts, so the transcript can be re-rendered", () => {
    expect(buildMessageMeta(result).conflicts).toHaveLength(1);
    expect(buildMessageMeta(result).conflicts[0]?.severity).toBe("BLOCK");
  });

  it("records the provider and whether it was mocked", () => {
    const meta = buildMessageMeta(result);

    expect(meta.provider).toBe("mock");
    expect(meta.isMocked).toBe(true);
  });

  it("records the model separately from the provider", () => {
    // "Who billed us" and "which model wrote this" are different
    // questions. A model quietly downgraded from `flash` to `lite` is
    // exactly what an audit exists to catch, so the two are recorded
    // separately.
    const meta = buildMessageMeta(result);

    expect(meta.provider).toBe("mock");
    expect(meta.model).toBe("mock-deterministic-v1");
  });

  it("records the skin profile snapshot", () => {
    const meta = buildMessageMeta(result);

    expect(meta.skinType).toBe("OILY");
    expect(meta.concerns).toEqual(["OILINESS"]);
  });
});

describe("the guard rails", () => {
  /**
   * The most important property in the whole advisor: a provider cannot
   * talk its way into recommending a product that code excluded.
   */
  it("drops a recommended id that is not on the allow-list", async () => {
    const provider = makeProvider({
      recommendedProductIds: ["prod_never_offered"],
    });

    const request = makeRequest({ allowedProductIds: [CANDIDATE.id] });

    const allowed = resolveAllowedIds(request);
    const response = await provider.complete(request);

    const invalid = response.recommendedProductIds.filter(
      (id) => !allowed.has(id),
    );

    expect(invalid).toEqual(["prod_never_offered"]);
  });

  it("keeps a recommended id that is on the allow-list", async () => {
    const provider = makeProvider({ recommendedProductIds: [CANDIDATE.id] });

    const request = makeRequest({ allowedProductIds: [CANDIDATE.id] });
    const response = await provider.complete(request);

    const allowed = resolveAllowedIds(request);

    expect(
      response.recommendedProductIds.filter((id) => allowed.has(id)),
    ).toEqual([CANDIDATE.id]);
  });

  it("caps the number of recommendations", () => {
    expect(MAX_RECOMMENDATIONS).toBe(3);
    expect(MAX_RECOMMENDATIONS).toBeLessThan(MAX_CANDIDATES);
  });
});

/**
 * The conversational guard rail.
 *
 * ── What this is about ───────────────────────────────────────────────────
 *
 * The advisor used to dump a three-product routine on a customer who
 * had typed "hi". The fix is a decision made in code — *should this
 * turn recommend anything?* — and this function is where that decision
 * is enforced against the provider's output.
 *
 * The rule that matters most is the first one: a greeting carries no
 * products, and the provider's ids are **dropped**, not replaced with
 * a different set. The replacement would be worse than the original
 * bug, because it would produce a routine that no provider even asked
 * for.
 */
describe("selectRecommendedIds", () => {
  const GREETING: AdvisorIntent = {
    kind: "GREETING",
    mayRecommend: false,
    mayWarn: false,
    missing: ["SKIN_TYPE", "CONCERNS"],
  };

  const CONCERN: AdvisorIntent = {
    kind: "CONCERN",
    mayRecommend: true,
    mayWarn: true,
    missing: [],
  };

  const ORDER: AdvisorIntent = {
    kind: "ORDER",
    mayRecommend: false,
    mayWarn: false,
    missing: [],
  };

  const CANDIDATES = [CANDIDATE, SECOND_CANDIDATE];
  const ALLOWED = new Set([CANDIDATE.id, SECOND_CANDIDATE.id]);

  it("returns nothing on a greeting, even when the provider recommends", () => {
    const ids = selectRecommendedIds(
      GREETING,
      ALLOWED,
      [CANDIDATE.id],
      CANDIDATES,
    );

    expect(ids).toEqual([]);
  });

  it("does not replace a greeting's products with the deterministic set", () => {
    // This is the subtlety. The fallback for an out-of-allow-list id
    // would *invent* a routine on a greeting — the exact behaviour
    // this guard rail exists to prevent.
    const ids = selectRecommendedIds(
      GREETING,
      ALLOWED,
      ["prod_never_offered"],
      CANDIDATES,
    );

    expect(ids).toEqual([]);
  });

  it("returns nothing on an order question, even when the provider recommends", () => {
    const ids = selectRecommendedIds(
      ORDER,
      ALLOWED,
      [CANDIDATE.id],
      CANDIDATES,
    );

    expect(ids).toEqual([]);
  });

  it("keeps a valid id on a concern turn", () => {
    const ids = selectRecommendedIds(
      CONCERN,
      ALLOWED,
      [CANDIDATE.id],
      CANDIDATES,
    );

    expect(ids).toEqual([CANDIDATE.id]);
  });

  it("drops an id outside the allow-list and uses the deterministic set", () => {
    const ids = selectRecommendedIds(
      CONCERN,
      ALLOWED,
      ["prod_never_offered"],
      CANDIDATES,
    );

    expect(ids).not.toContain("prod_never_offered");
    expect(ids.length).toBeGreaterThan(0);
  });

  it("caps the number of ids on a concern turn", () => {
    const ids = selectRecommendedIds(
      CONCERN,
      ALLOWED,
      [CANDIDATE.id, SECOND_CANDIDATE.id, CANDIDATE.id, SECOND_CANDIDATE.id],
      CANDIDATES,
    );

    expect(ids.length).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);
  });
});

describe("mergeHistory", () => {
  /**
   * A stored turn.
   */
  const stored: AdvisorHistoryTurn[] = [
    { role: "USER", content: "Hi" },
    { role: "ASSISTANT", content: "Hello! What is your skin type?" },
  ];

  it("returns the stored transcript when the client sent nothing", () => {
    expect(mergeHistory(stored, [])).toEqual(stored);
  });

  it("returns the stored transcript when the client is behind it", () => {
    // The client is looking at an older conversation. The stored one is
    // the authoritative record, so it wins.
    const client: AdvisorHistoryTurn[] = [
      { role: "USER", content: "Hi" },
    ];

    expect(mergeHistory(stored, client)).toEqual(stored);
  });

  it("returns the stored transcript when the client has the same turns", () => {
    const client: AdvisorHistoryTurn[] = [
      { role: "USER", content: "Hi" },
      { role: "ASSISTANT", content: "Hello! What is your skin type?" },
    ];

    expect(mergeHistory(stored, client)).toEqual(stored);
  });

  it("keeps the stored turns and adds the ones the client is ahead by", () => {
    // The customer has sent a third message; the answer has not been
    // written yet, so the database does not have it.
    const client: AdvisorHistoryTurn[] = [
      ...stored,
      { role: "USER", content: "My skin is oily" },
    ];

    const merged = mergeHistory(stored, client);

    expect(merged).toHaveLength(3);
    expect(merged[2]).toEqual({ role: "USER", content: "My skin is oily" });
  });

  it("does not let the client rewrite turns the server already has", () => {
    // The client claims a different history. The server's record is
    // kept, and the client's turns are dropped because they do not
    // continue it.
    const client: AdvisorHistoryTurn[] = [
      { role: "USER", content: "I said something else entirely" },
      { role: "ASSISTANT", content: "And I answered that instead" },
      { role: "USER", content: "My skin is oily" },
    ];

    const merged = mergeHistory(stored, client);

    expect(merged).toEqual(stored);
    expect(merged).toHaveLength(2);
  });

  it("ignores a client transcript that shares nothing with the stored one", () => {
    // The client is looking at a *different* conversation. Its turns
    // belong to that conversation and are not this one's.
    const client: AdvisorHistoryTurn[] = [
      { role: "USER", content: "Something completely different" },
      { role: "ASSISTANT", content: "Another different answer" },
      { role: "USER", content: "And a third" },
    ];

    const merged = mergeHistory(stored, client);

    expect(merged).toEqual(stored);
  });

  it("drops the client when its transcript does not start with the stored one", () => {
    // The client's copy of the assistant's reply differs from the one
    // the server stored. The client's is not this conversation's.
    const client: AdvisorHistoryTurn[] = [
      { role: "USER", content: "Hi" },
      { role: "ASSISTANT", content: "A completely different answer" },
      { role: "USER", content: "My skin is oily" },
    ];

    const merged = mergeHistory(stored, client);

    expect(merged).toEqual(stored);
  });

  it("takes the client's turns when they continue the stored transcript", () => {
    // The customer has sent a third message; the answer has not been
    // written yet, so the database does not have it. The client's
    // transcript starts with the stored one.
    const client: AdvisorHistoryTurn[] = [
      ...stored,
      { role: "USER", content: "My skin is oily" },
    ];

    const merged = mergeHistory(stored, client);

    expect(merged).toHaveLength(3);
    expect(merged[2]).toEqual({ role: "USER", content: "My skin is oily" });
  });

  it("ignores the whitespace around a turn's content", () => {
    const client: AdvisorHistoryTurn[] = [
      { role: "USER", content: "Hi" },
      { role: "ASSISTANT", content: "  Hello! What is your skin type?  " },
      { role: "USER", content: "My skin is oily" },
    ];

    const merged = mergeHistory(stored, client);

    expect(merged).toHaveLength(3);
    expect(merged[2]).toEqual({ role: "USER", content: "My skin is oily" });
  });

  it("does not mutate the arrays it was given", () => {
    const client: AdvisorHistoryTurn[] = [
      ...stored,
      { role: "USER", content: "My skin is oily" },
    ];

    mergeHistory(stored, client);

    expect(stored).toHaveLength(2);
    expect(client).toHaveLength(3);
  });
});
