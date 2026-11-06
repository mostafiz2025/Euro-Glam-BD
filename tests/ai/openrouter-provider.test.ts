import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_BASE_URL,
  OPENROUTER_PROVIDER_NAME,
  OpenRouterProvider,
} from "@/lib/ai/openrouter-provider";
import { MAX_COMPLETION_TOKENS } from "@/lib/ai/openai-compatible";
import {
  AiProviderError,
  type AdvisorRequest,
  type ProductCandidate,
} from "@/lib/ai/provider";
import { BANGLISH, BENGALI } from "@/lib/ai/language";

/**
 * The OpenRouter provider's tests.
 *
 * ── What these tests are really about ─────────────────────────────────────
 *
 * The OpenRouter provider is tested **without a network call**. `fetch` is
 * stubbed, so the test can capture the exact request the provider *would*
 * send and assert on its shape.
 *
 * The shape of that request is the contract with OpenRouter, and it is
 * the thing most likely to rot:
 *
 *   1. It goes to OpenRouter's endpoint — not OpenAI's, and not a
 *      hand-rolled URL that happens to work today.
 *   2. It carries the three OpenRouter headers: the bearer token, the
 *      `HTTP-Referer` and the `X-Title`.
 *   3. It asks OpenRouter to **fall back** to another upstream provider.
 *      That is the whole point of routing through a router, and it is
 *      the thing that turns a rate limit into a non-event.
 *   4. The body carries the same prompt the other providers send — the
 *      history as a real multi-turn transcript, the photo with the
 *      current turn, the language rule in the system prompt.
 *   5. The response is **untrusted**: an id outside the allow-list is
 *      dropped, and the marker line never reaches the customer.
 *   6. A rate limit is **retried**, and a bad key is **not**.
 */

/**
 * A candidate the advisor may recommend.
 */
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

/**
 * A second candidate, used to prove the allow-list narrows the result.
 */
const RETINOL_PRODUCT: ProductCandidate = {
  id: "prod_retinol",
  name: "Night Repair Retinol Serum",
  categoryName: "Skincare",
  pricePaisa: 245000,
  discountPricePaisa: null,
  ingredientTags: ["RETINOL"],
  climateTips: null,
  description: "A gentle retinol serum for night use.",
};

/**
 * The request the provider receives.
 */
function makeRequest(overrides: Partial<AdvisorRequest> = {}): AdvisorRequest {
  return {
    userMessage: "My skin is oily and breaking out.",
    profile: {
      skinType: "OILY",
      concerns: ["OILINESS", "ACNE"],
      notes: null,
    },
    candidates: [NIACINAMIDE_PRODUCT, RETINOL_PRODUCT],
    conflicts: [],
    allowedProductIds: null,
    systemPrompt: null,
    ...overrides,
  };
}

/**
 * The captured request.
 */
type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/**
 * A successful chat-completion response.
 */
function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "gen-1",
      model: "deepseek/deepseek-v4.1-flash-1017",
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * A response carrying a tool call — the structured channel.
 *
 * The arguments are a JSON **string**, because that is how the
 * chat-completions dialect carries them.
 */
function toolCallResponse(content: string, productIds: string[]): Response {
  return new Response(
    JSON.stringify({
      id: "gen-1",
      model: "deepseek/deepseek-v4.1-flash-1017",
      choices: [
        {
          message: {
            role: "assistant",
            content: content === "" ? null : content,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "recommend_products",
                  arguments: JSON.stringify({ productIds }),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Runs a body with `fetch` stubbed, and restores the real one after.
 *
 * The provider is built inside this helper so that every test gets a
 * fresh one, and so that `fetch` is always restored — a leaked stub
 * would make an unrelated test make a real network call.
 */
async function withStubbedFetch<T>(
  stub: (attempt: number) => Response,
  captured: CapturedRequest[],
  body: (provider: OpenRouterProvider) => Promise<T>,
  options: {
    readonly referer?: string | null;
    readonly title?: string | null;
  } = {},
): Promise<T> {
  const originalFetch = globalThis.fetch;

  // `undefined` means "not specified" and falls back to the default;
  // an explicit `null` means "send no header at all".
  const referer =
    options.referer === undefined ? "https://euroglambd.com" : options.referer;

  const title =
    options.title === undefined ? "Euro Glam BD" : options.title;

  let attempt = 0;

  globalThis.fetch = (async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};

    const rawHeaders = init?.headers;

    if (rawHeaders && typeof rawHeaders === "object") {
      for (const [key, value] of Object.entries(
        rawHeaders as Record<string, string>,
      )) {
        headers[key] = value;
      }
    }

    captured.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });

    attempt += 1;

    return stub(attempt);
  }) as typeof fetch;

  try {
    return await body(
      new OpenRouterProvider({
        apiKey: "test-key",
        model: "deepseek/deepseek-v4.1-flash-1017",
        referer,
        title,
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("OpenRouterProvider", () => {
  it("throws when no API key is configured", () => {
    const original = process.env.OPENROUTER_API_KEY;

    delete process.env.OPENROUTER_API_KEY;

    try {
      expect(() => new OpenRouterProvider()).toThrow(AiProviderError);
    } finally {
      if (original !== undefined) process.env.OPENROUTER_API_KEY = original;
    }
  });

  it("uses the configured model name", () => {
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      model: "deepseek/deepseek-v4.1-flash-1017",
    });

    expect(provider.modelName).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(provider.name).toBe(OPENROUTER_PROVIDER_NAME);
  });

  it("falls back to the default model when none is configured", () => {
    const original = process.env.OPENROUTER_MODEL;

    delete process.env.OPENROUTER_MODEL;

    try {
      const provider = new OpenRouterProvider({ apiKey: "test-key" });

      expect(provider.modelName).toBe(DEFAULT_OPENROUTER_MODEL);
    } finally {
      if (original !== undefined) process.env.OPENROUTER_MODEL = original;
    }
  });

  it("reads the model from the environment", () => {
    const original = process.env.OPENROUTER_MODEL;

    process.env.OPENROUTER_MODEL = "openai/gpt-6-luna";

    try {
      const provider = new OpenRouterProvider({ apiKey: "test-key" });

      expect(provider.modelName).toBe("openai/gpt-6-luna");
    } finally {
      if (original === undefined) {
        delete process.env.OPENROUTER_MODEL;
      } else {
        process.env.OPENROUTER_MODEL = original;
      }
    }
  });

  it("declares that it can see images", () => {
    const provider = new OpenRouterProvider({ apiKey: "test-key" });

    // The service layer uses this to decide whether to base64-encode
    // the customer's photograph at all.
    expect(provider.supportsVision).toBe(true);
  });

  describe("the request it sends", () => {
    it("calls OpenRouter's chat-completions endpoint", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(captured[0]?.url).toBe(
        `${OPENROUTER_BASE_URL}/chat/completions`,
      );
    });

    it("sends the bearer token", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(captured[0]?.headers.Authorization).toBe("Bearer test-key");
    });

    it("sends HTTP-Referer and X-Title", async () => {
      // OpenRouter uses these two to attribute the app — they are not
      // credentials, but they are what the shop sends.
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(captured[0]?.headers["HTTP-Referer"]).toBe(
        "https://euroglambd.com",
      );
      expect(captured[0]?.headers["X-Title"]).toBe("Euro Glam BD");
    });

    it("omits the optional headers when they are unknown", async () => {
      // An empty header is worse than an absent one.
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
        { referer: null, title: null },
      );

      expect(captured[0]?.headers["HTTP-Referer"]).toBeUndefined();
      expect(captured[0]?.headers["X-Title"]).toBeUndefined();
    });

    it("asks OpenRouter to fall back to another upstream provider", async () => {
      // This is the whole point of routing through a router: one
      // upstream provider being rate-limited must not become a failed
      // advisor turn.
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      const providerPreferences = captured[0]?.body.provider as
        | { allow_fallbacks?: boolean }
        | undefined;

      expect(providerPreferences?.allow_fallbacks).toBe(true);
    });

    it("sends the configured model", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(captured[0]?.body.model).toBe(
        "deepseek/deepseek-v4.1-flash-1017",
      );
    });

    it("does not constrain the response format", async () => {
      // The advisor used to ask for a strict JSON schema, and the model
      // obeyed it — which is why every reply had the same shape. Free
      // prose is the whole point of the refactor.
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(captured[0]?.body.response_format).toBeUndefined();
    });

    it("states a ceiling on the reply's length", async () => {
      /*
       * This is not a nicety, and the reason is a live failure.
       *
       * OpenRouter reserves credit against the model's *maximum* context
       * window when the request does not state a ceiling of its own,
       * and refuses the request when the balance cannot cover the
       * reservation:
       *
       * > This request requires more credits, or fewer max_tokens. You
       * > requested up to 131072 tokens, but can only afford 34923.
       *
       * The advisor's reply is a few hundred tokens. The reservation was
       * for the whole context, and the request was refused for it.
       */
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(captured[0]?.body.max_tokens).toBe(MAX_COMPLETION_TOKENS);
    });

    it("offers the model a way to report the ids it recommended", async () => {
      /*
       * The marker line alone is not enough.
       *
       * Measured against the live API on the conversation turn, the
       * marker was dropped in roughly a third of runs — and a dropped
       * marker means no product cards in the shop at all. The tool call
       * is the structured channel, and it is read alongside the marker
       * rather than instead of it.
       */
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      const tools = captured[0]?.body.tools as
        | Array<{ function?: { name?: string } }>
        | undefined;

      expect(tools?.[0]?.function?.name).toBe("recommend_products");
    });

    it("tells the model to write the prose as well as make the call", async () => {
      /*
       * A model given a tool sometimes answers with the call **alone**
       * and no prose at all — which was observed directly on the live
       * API, and is the worst outcome the advisor can produce.
       *
       * The rule is appended to the system prompt rather than baked into
       * the stored prompt, so an admin's override cannot lose it.
       */
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      const system = messages.find((message) => message.role === "system");

      expect(String(system?.content)).toContain(
        "Never skip the prose.",
      );
    });

    it("replays the conversation history as real turns", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({
              history: [
                { role: "USER", content: "I have oily skin." },
                { role: "ASSISTANT", content: "Here is a gentle cleanser." },
                {
                  role: "USER",
                  content: "Will this work with the sunscreen?",
                },
              ],
            }),
          ),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

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

    it("attaches the image to the current turn as a data URL", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({ image: { mimeType: "image/jpeg", base64: "AAAA" } }),
          ),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

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
      // A model that does not know a photo is attached will not look at
      // it — it will answer the text and ignore the image.
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({ image: { mimeType: "image/jpeg", base64: "AAAA" } }),
          ),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      const parts = messages[messages.length - 1]?.content as Array<
        Record<string, unknown>
      >;

      const textPart = parts.find((part) => part.type === "text");

      expect(String(textPart?.text)).toContain("PHOTO ATTACHED");
    });

    it("puts the language rule in the system prompt", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) =>
          provider.complete(makeRequest({ language: BANGLISH })),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      expect(String(messages[0]?.content)).toContain("Banglish");
    });

    it("keeps the hard rules in the system prompt", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      const system = String(messages[0]?.content);

      // The persona the shop asked for.
      expect(system).toContain("official AI Skincare Advisor");
      expect(system).toContain("Bangladesh");
      // And the rules that keep the model inside the catalogue.
      expect(system).toContain("Never invent a product");
      expect(system).toContain("do not downgrade its severity");
    });

    it("puts the candidate list and the skin profile in the brief", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      const parts = messages[messages.length - 1]?.content as Array<
        Record<string, unknown>
      >;

      const textPart = parts.find((part) => part.type === "text");
      const brief = String(textPart?.text);

      expect(brief).toContain("CUSTOMER QUESTION:");
      expect(brief).toContain("SKIN PROFILE:");
      expect(brief).toContain("skin type: OILY");
      expect(brief).toContain("CANDIDATES:");
      expect(brief).toContain(NIACINAMIDE_PRODUCT.id);
    });

    it("states the turn's intent in the system prompt", async () => {
      // The turn instruction is what stops the advisor dumping a
      // routine on a greeting.
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Hello!"),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({
              userMessage: "hi",
              intent: {
                kind: "GREETING",
                mayRecommend: false,
                mayWarn: false,
                missing: ["SKIN_TYPE", "CONCERNS"],
              },
            }),
          ),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      const system = String(messages[0]?.content);

      expect(system).toContain("THIS TURN IS A GREETING");
      expect(system).toContain("Recommend nothing on this turn");
    });

    it("tells the model the conflicts are irrelevant on a turn that may not warn", async () => {
      /*
       * The prompt-side half of the conflict gate.
       *
       * The service layer hands the model an **empty** conflict list on a
       * turn that may not warn, and the brief has to say so — otherwise
       * the model sees "CONFLICTS:" with nothing under it, and the
       * service layer's suppression of the *card* is not enough: the
       * warning would still reach the customer as **prose**.
       */
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Hello!"),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({
              userMessage: "hi",
              conflicts: [],
              intent: {
                kind: "GREETING",
                mayRecommend: false,
                mayWarn: false,
                missing: ["SKIN_TYPE", "CONCERNS"],
              },
            }),
          ),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      const parts = messages[messages.length - 1]?.content as Array<
        Record<string, unknown>
      >;

      const textPart = parts.find((part) => part.type === "text");
      const brief = String(textPart?.text);

      expect(brief).toContain("CONFLICTS:");
      expect(brief).toContain("not relevant to this turn");
      expect(brief).toContain("do not mention ingredient conflicts");
    });

    it("gives the model the conflict list on a turn that may warn", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({
              conflicts: [
                {
                  ruleId: "AHA_RETINOL_BLOCK",
                  severity: "BLOCK" as const,
                  title: "Do not use AHA exfoliants with retinoids",
                  message: "They conflict.",
                  remedy: "Choose one.",
                  spacingAdvice: "Not on the same day.",
                  involvedProductIds: [RETINOL_PRODUCT.id],
                  ingredientIds: ["AHA" as never],
                },
              ],
              intent: {
                kind: "CONCERN",
                mayRecommend: true,
                mayWarn: true,
                missing: [],
              },
            }),
          ),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      const parts = messages[messages.length - 1]?.content as Array<
        Record<string, unknown>
      >;

      const textPart = parts.find((part) => part.type === "text");
      const brief = String(textPart?.text);

      expect(brief).toContain("CONFLICTS (decided by code");
      expect(brief).toContain("AHA_RETINOL_BLOCK");
    });

    it("uses the admin's prompt override when there is one", async () => {
      const captured: CapturedRequest[] = [];

      await withStubbedFetch(
        () => okResponse("Here you go."),
        captured,
        (provider) =>
          provider.complete(makeRequest({ systemPrompt: "Be extremely brief." })),
      );

      const messages = captured[0]?.body.messages as Array<{
        role: string;
        content: unknown;
      }>;

      expect(String(messages[0]?.content)).toContain("Be extremely brief.");
    });
  });

  describe("the response it returns", () => {
    it("returns the model's prose as-is", async () => {
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () => okResponse("Here is a suggestion."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(response.content).toBe("Here is a suggestion.");
      expect(response.recommendedProductIds).toEqual([]);
      expect(response.providerName).toBe(OPENROUTER_PROVIDER_NAME);
      expect(response.modelName).toBe("deepseek/deepseek-v4.1-flash-1017");
      expect(response.isMocked).toBe(false);
    });

    it("reads the recommended ids out of the marker line", async () => {
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          okResponse(
            `Here is a suggestion.\n\n[RECOMMENDED: ${NIACINAMIDE_PRODUCT.id}]`,
          ),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    });

    it("removes the marker line from the prose the customer sees", async () => {
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          okResponse(
            `Here is a suggestion.\n\n[RECOMMENDED: ${NIACINAMIDE_PRODUCT.id}]`,
          ),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      // A customer must never see the machine-readable line.
      expect(response.content).not.toContain("RECOMMENDED");
      expect(response.content).toBe("Here is a suggestion.");
    });

    it("drops a recommended id that is not in the allow-list", async () => {
      // The model can name an id it was never given. It must not reach
      // the customer.
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () => okResponse("Here is a suggestion.\n\n[RECOMMENDED: prod_not_allowed]"),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({ allowedProductIds: [NIACINAMIDE_PRODUCT.id] }),
          ),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("keeps a recommended id that is in the allow-list", async () => {
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          okResponse(
            `Here is a suggestion.\n\n[RECOMMENDED: ${NIACINAMIDE_PRODUCT.id}]`,
          ),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({ allowedProductIds: [NIACINAMIDE_PRODUCT.id] }),
          ),
      );

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    });

    it("throws a provider error when the API returns a failure", async () => {
      const captured: CapturedRequest[] = [];

      await expect(
        withStubbedFetch(
          () => new Response("upstream failure", { status: 500 }),
          captured,
          (provider) => provider.complete(makeRequest()),
        ),
      ).rejects.toThrow(AiProviderError);
    });

    /*
     * ── The three channels ───────────────────────────────────────────────
     *
     * The ids come back on whichever channel carries them, and the
     * channels are consulted in order of how much the model had to
     * cooperate. These tests are the contract for each of them.
     */

    it("reads the ids out of the tool call", async () => {
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          toolCallResponse("Here is a suggestion.", [
            NIACINAMIDE_PRODUCT.id,
          ]),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    });

    it("prefers the tool call over the marker line", async () => {
      // The tool call is the structured channel, so it comes first. The
      // marker still adds anything the call missed.
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          toolCallResponse(
            `Here is a suggestion.\n\n[RECOMMENDED: ${RETINOL_PRODUCT.id}]`,
            [NIACINAMIDE_PRODUCT.id],
          ),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
        RETINOL_PRODUCT.id,
      ]);
    });

    it("recovers the ids from the product names when the marker is missing", async () => {
      /*
       * The marker was measured being dropped in roughly a third of live
       * conversation turns, and a dropped marker means no product cards.
       *
       * But the model *names* the products it recommends — that is what
       * recommending means in prose — and the name is in the candidate
       * list. So the ids can be recovered from the prose when the other
       * channels come back empty.
       */
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          okResponse(
            `Start with the ${NIACINAMIDE_PRODUCT.name} for your oily skin.`,
          ),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    });

    it("does not treat a named product as a recommendation when the model said so", async () => {
      /*
       * A product can be *mentioned* without being recommended — to warn
       * against it, for example. The marker and the tool call are
       * statements; a name is only an observation.
       *
       * So the name channel is the last resort, and it does not fire
       * when the model has explicitly said it recommended nothing.
       */
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          okResponse(
            `Skip the ${NIACINAMIDE_PRODUCT.name} for now — start with the ${RETINOL_PRODUCT.name}.\n\n[RECOMMENDED: none]`,
          ),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("does not name a conflicted product as a recommendation", async () => {
      /*
       * A conflicted product is one the model has been asked to **warn
       * about** — so naming it is the warning, not a recommendation, and
       * it must not become a product card.
       */
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          okResponse(
            `I would skip the ${NIACINAMIDE_PRODUCT.name} for now — it clashes with what you already use.`,
          ),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({
              conflicts: [
                {
                  ruleId: "RETINOL_WITH_HA",
                  severity: "WARN",
                  title: "Retinol with acids",
                  message: "Do not use these together.",
                  involvedProductIds: [NIACINAMIDE_PRODUCT.id],
                  ingredientIds: [],
                  remedy: "Space them apart.",
                  spacingAdvice: "Use one in the morning.",
                },
              ],
            }),
          ),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("does not invent a recommendation on a turn that does not call for one", async () => {
      // A greeting names no products, but the guard has to hold even if
      // one did.
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        () =>
          okResponse(
            `Hello! Try the ${NIACINAMIDE_PRODUCT.name} — it is on sale today.`,
          ),
        captured,
        (provider) =>
          provider.complete(
            makeRequest({
              intent: {
                kind: "GREETING",
                mayRecommend: false,
                mayWarn: false,
                missing: ["SKIN_TYPE"],
              },
            }),
          ),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("retries when the model answers with a tool call and no prose", async () => {
      /*
       * The worst outcome the advisor can produce, and it arrives as a
       * perfectly healthy `200` — so a status-code check cannot see it.
       *
       * It is also transient: it is a sampling accident, and the same
       * model writes the prose on the next attempt. So it is retried.
       */
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        (attempt) =>
          attempt === 1
            ? toolCallResponse("", [NIACINAMIDE_PRODUCT.id])
            : okResponse("Here is a suggestion."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(captured).toHaveLength(2);
      expect(response.content).toBe("Here is a suggestion.");
    });

    it("retries a tool call with an empty id list and no prose", async () => {
      /*
       * The greeting turn produces exactly this: a call with an **empty**
       * id list — the model correctly saying "I recommended nothing" —
       * and no prose beside it.
       *
       * So the retry cannot be keyed on the ids the call carried. It has
       * to be keyed on the call's *presence*, because a call with
       * nothing in it is still a reply the customer cannot read.
       *
       * This was a live bug: the greeting failed with "The AI provider
       * returned an empty response" instead of being retried.
       */
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        (attempt) =>
          attempt === 1
            ? toolCallResponse("", [])
            : okResponse("Hello! What is your skin like?"),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(captured).toHaveLength(2);
      expect(response.content).toBe("Hello! What is your skin like?");
      expect(response.recommendedProductIds).toEqual([]);
    });

    it("throws a provider error when the response is empty", async () => {
      const captured: CapturedRequest[] = [];

      await expect(
        withStubbedFetch(
          () =>
            new Response(
              JSON.stringify({ choices: [{ message: { content: "" } }] }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          captured,
          (provider) => provider.complete(makeRequest()),
        ),
      ).rejects.toThrow(AiProviderError);
    });

    it("throws a provider error when the body carries an error", async () => {
      // OpenRouter can report an upstream provider's failure inside a
      // `200` response. That must not become an empty answer.
      const captured: CapturedRequest[] = [];

      await expect(
        withStubbedFetch(
          () =>
            new Response(
              JSON.stringify({
                error: { message: "upstream provider failed" },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          captured,
          (provider) => provider.complete(makeRequest()),
        ),
      ).rejects.toThrow(/upstream provider failed/);
    });

    it("throws a provider error when a choice carries an error", async () => {
      const captured: CapturedRequest[] = [];

      await expect(
        withStubbedFetch(
          () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: { content: null },
                    error: { message: "the model is overloaded" },
                  },
                ],
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          captured,
          (provider) => provider.complete(makeRequest()),
        ),
      ).rejects.toThrow(/the model is overloaded/);
    });
  });

  /**
   * The retry.
   *
   * A rate limit is the failure this whole provider exists to route
   * around, so it must be retried rather than thrown at the customer
   * on the first attempt. A bad key must not be.
   */
  describe("the retry", () => {
    it("retries a 429 and succeeds", async () => {
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        (attempt) =>
          attempt === 1
            ? new Response("rate limited", { status: 429 })
            : okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(response.content).toBe("Here you go.");
      expect(captured).toHaveLength(2);
    });

    it("retries a 503 and succeeds", async () => {
      const captured: CapturedRequest[] = [];

      const response = await withStubbedFetch(
        (attempt) =>
          attempt === 1
            ? new Response("upstream unavailable", { status: 503 })
            : okResponse("Here you go."),
        captured,
        (provider) => provider.complete(makeRequest()),
      );

      expect(response.content).toBe("Here you go.");
      expect(captured).toHaveLength(2);
    });

    it("gives up after the attempt cap", async () => {
      const captured: CapturedRequest[] = [];

      await expect(
        withStubbedFetch(
          () => new Response("rate limited", { status: 429 }),
          captured,
          (provider) => provider.complete(makeRequest()),
        ),
      ).rejects.toThrow(AiProviderError);

      // Three attempts, then it gives up.
      expect(captured).toHaveLength(3);
    });

    it("does not retry a 401 — a wrong key will still be wrong", async () => {
      const captured: CapturedRequest[] = [];

      await expect(
        withStubbedFetch(
          () => new Response("unauthorized", { status: 401 }),
          captured,
          (provider) => provider.complete(makeRequest()),
        ),
      ).rejects.toThrow(/API key/i);

      // One attempt. Retrying would only waste the customer's time.
      expect(captured).toHaveLength(1);
    });

    it("does not retry a 404 — a model that does not exist will not appear", async () => {
      const captured: CapturedRequest[] = [];

      await expect(
        withStubbedFetch(
          () => new Response("no such model", { status: 404 }),
          captured,
          (provider) => provider.complete(makeRequest()),
        ),
      ).rejects.toThrow(/OPENROUTER_MODEL/);

      expect(captured).toHaveLength(1);
    });

    it("names the setting when the model cannot read images", async () => {
      // A text-only model and a model that does not exist are **both**
      // a 404, and they need different fixes. OpenRouter says which it
      // is, and the error has to pass that on — otherwise the operator
      // goes looking for a typo in the model id when the real problem is
      // that the model has no vision.
      const captured: CapturedRequest[] = [];

      await expect(
        withStubbedFetch(
          () =>
            new Response(
              JSON.stringify({
                error: {
                  message: "No endpoints found that support image input",
                  code: 404,
                  metadata: { failed_routing_step: "Filter by Image Support" },
                },
              }),
              { status: 404 },
            ),
          captured,
          (provider) =>
            provider.complete(
              makeRequest({ image: { mimeType: "image/jpeg", base64: "AAAA" } }),
            ),
        ),
      ).rejects.toThrow(/cannot read images/i);

      // A text-only model will still be text-only on the retry.
      expect(captured).toHaveLength(1);
    });
  });
});

/**
 * The provider registry.
 */
describe("getAiProvider with openrouter", () => {
  it("returns the OpenRouter provider when it is configured", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    const originalKey = process.env.OPENROUTER_API_KEY;

    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-key";

    try {
      const { getAiProvider } = await import("@/lib/ai");

      const provider = await getAiProvider();

      expect(provider.name).toBe(OPENROUTER_PROVIDER_NAME);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }

      if (originalKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalKey;
      }
    }
  });

  it("refuses to start when openrouter is selected without an API key", async () => {
    const originalProvider = process.env.AI_PROVIDER;
    const originalKey = process.env.OPENROUTER_API_KEY;

    process.env.AI_PROVIDER = "openrouter";
    delete process.env.OPENROUTER_API_KEY;

    try {
      const { getAiProvider } = await import("@/lib/ai");

      await expect(getAiProvider()).rejects.toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (originalProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = originalProvider;
      }

      if (originalKey !== undefined) process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  it("is case-insensitive", async () => {
    const original = process.env.AI_PROVIDER;

    process.env.AI_PROVIDER = "OPENROUTER";

    try {
      const { getAiProviderName } = await import("@/lib/ai");

      expect(getAiProviderName()).toBe("openrouter");
    } finally {
      if (original === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = original;
      }
    }
  });
});

/**
 * The language rule reaches the model through the shared protocol, so
 * the OpenRouter provider must speak the same dialect as the OpenAI one.
 */
describe("the OpenRouter and OpenAI providers agree", () => {
  it("send the same prompt for the same request", async () => {
    const openRouterCaptured: CapturedRequest[] = [];
    const openAiCaptured: CapturedRequest[] = [];

    const request = makeRequest({
      language: BENGALI,
      history: [{ role: "USER", content: "I have oily skin." }],
    });

    await withStubbedFetch(
      () => okResponse("Here you go."),
      openRouterCaptured,
      (provider) => provider.complete(request),
    );

    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (
      _input: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      openAiCaptured.push({
        url: "",
        headers: {},
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });

      return okResponse("Here you go.");
    }) as typeof fetch;

    try {
      const { OpenAiProvider } = await import("@/lib/ai/openai-provider");

      await new OpenAiProvider({
        apiKey: "test-key",
        model: "deepseek/deepseek-v4.1-flash-1017",
      }).complete(request);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The messages are identical. Only the routing preferences differ,
    // and they are OpenRouter-specific.
    expect(openRouterCaptured[0]?.body.messages).toEqual(
      openAiCaptured[0]?.body.messages,
    );
  });
});
