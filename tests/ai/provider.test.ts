import { describe, expect, it } from "vitest";

import { MockProvider, MOCK_PROVIDER_NAME } from "@/lib/ai/mock-provider";
import {
  AiProviderError,
  formatPricePaisa,
  type AdvisorRequest,
  type ConflictReport,
  type ProductCandidate,
} from "@/lib/ai/provider";
import { OpenAiProvider } from "@/lib/ai/openai-provider";
import { BANGLISH, BENGALI } from "@/lib/ai/language";
import { getAiProvider, getAiProviderName } from "@/lib/ai";

/**
 * AI provider tests.
 *
 * The mock provider's determinism is the important property here. It is
 * what lets CI assert exact output, what makes the demo reproducible, and
 * what proves the pipeline works with no API key and no network.
 *
 * The OpenAI provider is tested without a network call — the response
 * validation and the allow-list enforcement are the parts that matter, and
 * both are pure.
 */

const RETINOL_PRODUCT: ProductCandidate = {
  id: "prod_retinol",
  name: "Night Repair Retinol Serum",
  categoryName: "Skincare",
  pricePaisa: 245000,
  discountPricePaisa: null,
  ingredientTags: ["RETINOL", "HYALURONIC_ACID"],
  climateTips: "Keep it in the fridge if you live somewhere hot.",
  description: "A gentle retinol serum for night use.",
};

const AHA_PRODUCT: ProductCandidate = {
  id: "prod_aha",
  name: "Brightening AHA Toner",
  categoryName: "Skincare",
  pricePaisa: 180000,
  discountPricePaisa: 150000,
  ingredientTags: ["GLYCOLIC_ACID", "NIACINAMIDE"],
  climateTips: null,
  description: "A glycolic acid toner for uneven tone.",
};

const NIACINAMIDE_PRODUCT: ProductCandidate = {
  id: "prod_niacinamide",
  name: "Niacinamide 10% Serum",
  categoryName: "Skincare",
  pricePaisa: 120000,
  discountPricePaisa: null,
  ingredientTags: ["NIACINAMIDE"],
  climateTips: null,
  description: "A balancing serum for oily skin.",
};

const BLOCK_CONFLICT: ConflictReport = {
  ruleId: "AHA_RETINOL_BLOCK",
  severity: "BLOCK",
  title: "Do not use AHA exfoliants with retinoids",
  message: "AHA exfoliants and retinoids are both strong actives.",
  involvedProductIds: ["prod_retinol", "prod_aha"],
  ingredientIds: ["AHA", "RETINOID"],
  remedy: "Choose one active for now.",
  spacingAdvice: "Do not use them on the same day.",
};

/**
 * Builds a request for the tests.
 */
function makeRequest(overrides: Partial<AdvisorRequest> = {}): AdvisorRequest {
  return {
    userMessage: "My skin is breaking out and I have sensitive skin.",
    profile: {
      skinType: "SENSITIVE",
      concerns: ["acne", "redness"],
      notes: null,
    },
    candidates: [RETINOL_PRODUCT, AHA_PRODUCT, NIACINAMIDE_PRODUCT],
    conflicts: [],
    allowedProductIds: null,
    systemPrompt: null,
    ...overrides,
  };
}

describe("MockProvider", () => {
  const provider = new MockProvider();

  it("reports its name and marks the response as mocked", async () => {
    const response = await provider.complete(makeRequest());

    expect(response.providerName).toBe(MOCK_PROVIDER_NAME);
    expect(response.isMocked).toBe(true);
    expect(response.modelName.length).toBeGreaterThan(0);
  });

  describe("determinism", () => {
    it("returns byte-identical output for identical input", async () => {
      const request = makeRequest();

      const first = await provider.complete(request);
      const second = await provider.complete(request);

      expect(second.content).toBe(first.content);
      expect(second.recommendedProductIds).toEqual(
        first.recommendedProductIds,
      );
    });

    it("returns identical output across separate provider instances", async () => {
      const request = makeRequest();

      const first = await new MockProvider().complete(request);
      const second = await new MockProvider().complete(request);

      expect(second.content).toBe(first.content);
    });

    it("returns identical output across many repetitions", async () => {
      const request = makeRequest();

      const first = await provider.complete(request);

      for (let index = 0; index < 20; index += 1) {
        const next = await provider.complete(request);
        expect(next.content).toBe(first.content);
      }
    });

    it("produces different output for a different question", async () => {
      const first = await provider.complete(
        makeRequest({ userMessage: "I have oily skin." }),
      );
      const second = await provider.complete(
        makeRequest({ userMessage: "I need baby care products." }),
      );

      expect(second.content).not.toBe(first.content);
    });
  });

  describe("recommendations", () => {
    it("recommends only from the candidate list", async () => {
      const response = await provider.complete(makeRequest());

      const candidateIds = new Set([
        RETINOL_PRODUCT.id,
        AHA_PRODUCT.id,
        NIACINAMIDE_PRODUCT.id,
      ]);

      for (const id of response.recommendedProductIds) {
        expect(candidateIds.has(id)).toBe(true);
      }
    });

    it("respects the allow-list", async () => {
      const response = await provider.complete(
        makeRequest({ allowedProductIds: [NIACINAMIDE_PRODUCT.id] }),
      );

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    });

    it("recommends nothing when the allow-list is empty", async () => {
      const response = await provider.complete(
        makeRequest({ allowedProductIds: [] }),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("recommends nothing when there are no candidates", async () => {
      const response = await provider.complete(makeRequest({ candidates: [] }));

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("never recommends a product that is not a candidate", async () => {
      // An allow-list naming a product that was never offered must not
      // cause the provider to invent it.
      const response = await provider.complete(
        makeRequest({ allowedProductIds: ["prod_ghost"] }),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });
  });

  describe("conflicts", () => {
    it("reflects the conflicts it was given", async () => {
      const response = await provider.complete(
        makeRequest({ conflicts: [BLOCK_CONFLICT] }),
      );

      expect(response.content).toContain("AHA_RETINOL_BLOCK");
      expect(response.content).toContain(
        "Do not use AHA exfoliants with retinoids",
      );
    });

    it("includes the remedy from the conflict", async () => {
      const response = await provider.complete(
        makeRequest({ conflicts: [BLOCK_CONFLICT] }),
      );

      expect(response.content).toContain("Choose one active for now.");
    });

    it("does not invent a conflict that was not supplied", async () => {
      const response = await provider.complete(makeRequest());

      expect(response.content).not.toContain("AHA_RETINOL_BLOCK");
    });

    it("produces different output when a conflict is added", async () => {
      const without = await provider.complete(makeRequest());
      const with_ = await provider.complete(
        makeRequest({ conflicts: [BLOCK_CONFLICT] }),
      );

      expect(with_.content).not.toBe(without.content);
    });
  });

  describe("behavioural contract", () => {
    it("acknowledges the skin profile", async () => {
      const response = await provider.complete(makeRequest());

      expect(response.content.toLowerCase()).toContain("sensitive");
    });

    it("mentions the price of a recommended product", async () => {
      const response = await provider.complete(
        makeRequest({ allowedProductIds: [RETINOL_PRODUCT.id] }),
      );

      expect(response.content).toContain("৳2,450");
    });
  });

  /*
   * The conversational behaviour.
   *
   * The mock is what most people actually run, so it has to behave the
   * way the storefront ships. A mock that dumped a three-product
   * routine on "hi" while Gemini greeted the customer back would
   * contradict the product.
   */
  describe("the conversational contract", () => {
    const GREETING = {
      kind: "GREETING" as const,
      mayRecommend: false,
      mayWarn: false,
      missing: ["SKIN_TYPE", "CONCERNS"] as const,
    };

    it("greets back and asks about the skin on a greeting turn", async () => {
      const response = await provider.complete(
        makeRequest({ userMessage: "hi", intent: GREETING }),
      );

      expect(response.content.toLowerCase()).toContain("skin type");
    });

    it("recommends nothing on a greeting turn", async () => {
      const response = await provider.complete(
        makeRequest({ userMessage: "hi", intent: GREETING }),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("mentions no price on a greeting turn", async () => {
      // A price means a product was mentioned, and a product on a
      // greeting is the bug this whole module exists to fix.
      const response = await provider.complete(
        makeRequest({ userMessage: "hi", intent: GREETING }),
      );

      expect(response.content).not.toContain("৳");
    });

    it("recommends nothing on an order question", async () => {
      const response = await provider.complete(
        makeRequest({
          userMessage: "how long does delivery take?",
          intent: {
            kind: "ORDER",
            mayRecommend: false,
            mayWarn: false,
            missing: [],
          },
        }),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("recommends on a concern turn", async () => {
      const response = await provider.complete(
        makeRequest({
          userMessage: "my skin is oily and breaking out",
          intent: {
            kind: "CONCERN",
            mayRecommend: true,
            mayWarn: true,
            missing: [],
          },
        }),
      );

      expect(response.recommendedProductIds.length).toBeGreaterThan(0);
    });

    it("asks one question back rather than a list of them", async () => {
      // A customer asked four things at once answers none of them.
      const response = await provider.complete(
        makeRequest({
          userMessage: "my skin is oily",
          intent: {
            kind: "CONCERN",
            mayRecommend: true,
            mayWarn: true,
            missing: ["CONCERNS"],
          },
        }),
      );

      const questions = response.content.match(/\?/g) ?? [];

      expect(questions.length).toBe(1);
    });
  });
});

describe("formatPricePaisa", () => {
  it("formats whole taka", () => {
    expect(formatPricePaisa(245000)).toBe("৳2,450");
  });

  it("formats poisha", () => {
    expect(formatPricePaisa(245050)).toBe("৳2,450.50");
  });

  it("formats zero", () => {
    expect(formatPricePaisa(0)).toBe("৳0");
  });
});

describe("getAiProviderName", () => {
  it("defaults to mock when the env var is unset", () => {
    const original = process.env.AI_PROVIDER;

    delete process.env.AI_PROVIDER;

    try {
      expect(getAiProviderName()).toBe("mock");
    } finally {
      if (original !== undefined) process.env.AI_PROVIDER = original;
    }
  });

  it("returns openai when configured", () => {
    const original = process.env.AI_PROVIDER;

    process.env.AI_PROVIDER = "openai";

    try {
      expect(getAiProviderName()).toBe("openai");
    } finally {
      if (original === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = original;
      }
    }
  });

  it("returns gemini when configured", () => {
    const original = process.env.AI_PROVIDER;

    process.env.AI_PROVIDER = "gemini";

    try {
      expect(getAiProviderName()).toBe("gemini");
    } finally {
      if (original === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = original;
      }
    }
  });

  it("is case-insensitive for gemini", () => {
    const original = process.env.AI_PROVIDER;

    process.env.AI_PROVIDER = "GEMINI";

    try {
      expect(getAiProviderName()).toBe("gemini");
    } finally {
      if (original === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = original;
      }
    }
  });

  it("is case-insensitive", () => {
    const original = process.env.AI_PROVIDER;

    process.env.AI_PROVIDER = "MOCK";

    try {
      expect(getAiProviderName()).toBe("mock");
    } finally {
      if (original === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = original;
      }
    }
  });

  it("falls back to mock for an unrecognised value", () => {
    const original = process.env.AI_PROVIDER;

    process.env.AI_PROVIDER = "not-a-provider";

    try {
      expect(getAiProviderName()).toBe("mock");
    } finally {
      if (original === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = original;
      }
    }
  });
});

describe("OpenAiProvider", () => {
  it("throws when no API key is configured", () => {
    const original = process.env.OPENAI_API_KEY;

    delete process.env.OPENAI_API_KEY;

    try {
      expect(() => new OpenAiProvider()).toThrow(AiProviderError);
    } finally {
      if (original !== undefined) process.env.OPENAI_API_KEY = original;
    }
  });

  it("uses the configured model name", () => {
    const provider = new OpenAiProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });

    expect(provider.modelName).toBe("gpt-4o-mini");
    expect(provider.name).toBe("openai");
  });

  it("drops a recommended id that is not in the allow-list", async () => {
    const provider = new OpenAiProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });

    // A stubbed fetch that names a product id the allow-list does not
    // contain. The provider must filter it out before returning.
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Here is a suggestion.\n\n[RECOMMENDED: prod_not_allowed]",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const response = await provider.complete(
        makeRequest({ allowedProductIds: [NIACINAMIDE_PRODUCT.id] }),
      );

      expect(response.recommendedProductIds).toEqual([]);
      expect(response.isMocked).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a recommended id that is in the allow-list", async () => {
    const provider = new OpenAiProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });

    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `Here is a suggestion.\n\n[RECOMMENDED: ${NIACINAMIDE_PRODUCT.id}]`,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const response = await provider.complete(
        makeRequest({ allowedProductIds: [NIACINAMIDE_PRODUCT.id] }),
      );

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("removes the marker line from the prose the customer sees", async () => {
    // A machine-readable line must never reach the customer.
    const provider = new OpenAiProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });

    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `Here is a suggestion.\n\n[RECOMMENDED: ${NIACINAMIDE_PRODUCT.id}]`,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const response = await provider.complete(makeRequest());

      expect(response.content).not.toContain("RECOMMENDED");
      expect(response.content).toBe("Here is a suggestion.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws a provider error when the API returns a failure", async () => {
    const provider = new OpenAiProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });

    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response("upstream failure", { status: 500 })) as typeof fetch;

    try {
      await expect(provider.complete(makeRequest())).rejects.toThrow(
        AiProviderError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws a provider error when the response is empty", async () => {
    const provider = new OpenAiProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });

    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      await expect(provider.complete(makeRequest())).rejects.toThrow(
        AiProviderError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /*
   * The request shape.
   *
   * These tests capture the body the provider actually sends, because
   * the shape of that body is the contract with the model: the history
   * has to be a real multi-turn transcript, the image has to ride with
   * the current turn, and the language rule has to reach the system
   * prompt.
   */
  describe("the request it sends", () => {
    /**
     * Captures the body the provider would send.
     */
    async function captureBody(
      request: AdvisorRequest,
    ): Promise<Record<string, unknown>> {
      const provider = new OpenAiProvider({
        apiKey: "test-key",
        model: "gpt-4o-mini",
      });

      const originalFetch = globalThis.fetch;
      let captured: Record<string, unknown> = {};

      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Here is a suggestion.",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      try {
        await provider.complete(request);
      } finally {
        globalThis.fetch = originalFetch;
      }

      return captured;
    }

    /**
     * The messages, as a typed array.
     */
    function messagesOf(body: Record<string, unknown>): Array<{
      role: string;
      content: unknown;
    }> {
      return body.messages as Array<{ role: string; content: unknown }>;
    }

    it("replays the conversation history as real turns", async () => {
      const body = await captureBody(
        makeRequest({
          history: [
            { role: "USER", content: "I have oily skin." },
            { role: "ASSISTANT", content: "Here is a gentle cleanser." },
            { role: "USER", content: "Will this work with the sunscreen?" },
          ],
        }),
      );

      const messages = messagesOf(body);

      // The system prompt, then the three history turns, then the
      // current turn.
      expect(messages).toHaveLength(5);

      expect(messages[0]?.role).toBe("system");
      expect(messages[1]).toEqual({
        role: "user",
        content: "I have oily skin.",
      });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: "Here is a gentle cleanser.",
      });
      expect(messages[3]).toEqual({
        role: "user",
        content: "Will this work with the sunscreen?",
      });
      expect(messages[4]?.role).toBe("user");
    });

    it("puts the history in chronological order", async () => {
      // The service layer reverses the newest-first query result, so
      // the provider receives the turns in the order they happened.
      const body = await captureBody(
        makeRequest({
          history: [
            { role: "USER", content: "First question." },
            { role: "ASSISTANT", content: "First answer." },
            { role: "USER", content: "Second question." },
          ],
        }),
      );

      const messages = messagesOf(body);

      // The three history turns, in the order they happened.
      expect(messages[1]?.content).toBe("First question.");
      expect(messages[2]?.content).toBe("First answer.");
      expect(messages[3]?.content).toBe("Second question.");

      // And the current turn is last.
      expect(messages[messages.length - 1]?.role).toBe("user");
    });

    it("skips a history turn with no content", async () => {
      // An empty assistant turn would teach the model that it may
      // answer with nothing.
      const body = await captureBody(
        makeRequest({
          history: [
            { role: "USER", content: "A real question." },
            { role: "ASSISTANT", content: "   " },
          ],
        }),
      );

      const messages = messagesOf(body);

      expect(messages).toHaveLength(3);
      expect(messages[1]?.content).toBe("A real question.");
    });

    it("sends no history turns when there is no history", async () => {
      const body = await captureBody(makeRequest({ history: [] }));

      const messages = messagesOf(body);

      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe("system");
      expect(messages[1]?.role).toBe("user");
    });

    it("attaches the image to the current turn as a data URL", async () => {
      const body = await captureBody(
        makeRequest({
          image: { mimeType: "image/jpeg", base64: "AAAA" },
        }),
      );

      const messages = messagesOf(body);
      const current = messages[messages.length - 1];

      expect(Array.isArray(current?.content)).toBe(true);

      const parts = current?.content as Array<Record<string, unknown>>;
      const imagePart = parts.find((part) => part.type === "image_url");

      expect(imagePart).toBeDefined();
      expect(
        (imagePart?.image_url as { url: string }).url,
      ).toBe("data:image/jpeg;base64,AAAA");
    });

    it("tells the model a photo is attached", async () => {
      // A model that does not know a photo is attached will not look
      // at it — it will answer the text and ignore the image.
      const body = await captureBody(
        makeRequest({
          image: { mimeType: "image/jpeg", base64: "AAAA" },
        }),
      );

      const messages = messagesOf(body);
      const parts = messages[messages.length - 1]?.content as Array<
        Record<string, unknown>
      >;
      const textPart = parts.find((part) => part.type === "text");

      expect(String(textPart?.text)).toContain("PHOTO ATTACHED");
    });

    it("sends no image part when there is no image", async () => {
      const body = await captureBody(makeRequest());

      const messages = messagesOf(body);
      const parts = messages[messages.length - 1]?.content as Array<
        Record<string, unknown>
      >;

      expect(parts.find((part) => part.type === "image_url")).toBeUndefined();
    });

    it("puts the language rule in the system prompt", async () => {
      const body = await captureBody(
        makeRequest({ language: BANGLISH }),
      );

      const messages = messagesOf(body);
      const system = String(messages[0]?.content);

      expect(system).toContain("Banglish");
    });

    it("does not constrain the response format", async () => {
      // The advisor used to ask for a strict JSON schema, and the model
      // obeyed it — which is why every reply had the same shape. Free
      // prose is the point of the refactor.
      const body = await captureBody(makeRequest());

      expect(body.response_format).toBeUndefined();
    });

    it("asks the model to report its recommendations on a marker line", async () => {
      // The ids have to come back somehow once the schema is gone.
      const body = await captureBody(makeRequest());

      const messages = messagesOf(body);
      const system = String(messages[0]?.content);

      expect(system).toContain("[RECOMMENDED:");
    });

    it("keeps the hard rules in the system prompt", async () => {
      const body = await captureBody(makeRequest());

      const system = String(messagesOf(body)[0]?.content);

      // The persona the shop asked for.
      expect(system).toContain("official AI Skincare Advisor");
      expect(system).toContain("Bangladesh");
      // And the rules that keep the model inside the catalogue.
      expect(system).toContain("Never invent a product");
      expect(system).toContain("do not downgrade its severity");
    });

    it("uses the admin's prompt override when there is one", async () => {
      const body = await captureBody(
        makeRequest({ systemPrompt: "Be extremely brief." }),
      );

      const system = String(messagesOf(body)[0]?.content);

      expect(system).toContain("Be extremely brief.");
    });

    it("still applies the language rule to an admin's prompt override", async () => {
      // An override replaces the persona, but it must not be able to
      // lose the language behaviour — a customer who writes in Bengali
      // must be answered in Bengali whatever the admin typed.
      const body = await captureBody(
        makeRequest({ systemPrompt: "Be extremely brief.", language: BENGALI }),
      );

      const system = String(messagesOf(body)[0]?.content);

      expect(system).toContain("Be extremely brief.");
      expect(system).toContain("Bengali");
    });
  });

  it("declares that it can see images", () => {
    const provider = new OpenAiProvider({
      apiKey: "test-key",
      model: "gpt-4o-mini",
    });

    expect(provider.supportsVision).toBe(true);
  });
});

describe("MockProvider vision", () => {
  it("declares that it cannot see images", () => {
    // The service layer uses this to decide whether to base64-encode
    // the customer's photograph at all.
    expect(new MockProvider().supportsVision).toBe(false);
  });
});

/**
 * The provider registry.
 *
 * The registry is the only place that decides **which** provider runs.
 * Two properties matter:
 *
 *   1. A real provider with no API key is a **hard failure**, not a
 *      silent fall back to the mock. A staging deployment that looks
 *      healthy while serving canned advice is worse than one that
 *      refuses to start.
 *   2. In mock mode, no real provider's SDK is loaded at all.
 */
describe("getAiProvider", () => {
  it("returns the mock provider by default", async () => {
    const original = process.env.AI_PROVIDER;

    delete process.env.AI_PROVIDER;

    try {
      const provider = await getAiProvider();

      expect(provider.name).toBe(MOCK_PROVIDER_NAME);
      // `isMocked` lives on the *response*, not the provider — the
      // provider knows what it is, the response records what it did.
      expect(provider.supportsVision).toBe(false);
    } finally {
      if (original !== undefined) process.env.AI_PROVIDER = original;
    }
  });

  it("refuses to start when gemini is selected without an API key", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    const originalKey = process.env.GEMINI_API_KEY;

    process.env.AI_PROVIDER = "gemini";
    delete process.env.GEMINI_API_KEY;

    try {
      await expect(getAiProvider()).rejects.toThrow(/GEMINI_API_KEY/);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }

      if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("refuses to start when openai is selected without an API key", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    const originalKey = process.env.OPENAI_API_KEY;

    process.env.AI_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;

    try {
      await expect(getAiProvider()).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }

      if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
    }
  });
});
