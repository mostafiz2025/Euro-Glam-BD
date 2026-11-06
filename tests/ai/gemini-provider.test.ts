import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_PROVIDER_NAME,
  GeminiProvider,
} from "@/lib/ai/gemini-provider";
import {
  AiProviderError,
  type AdvisorRequest,
  type ProductCandidate,
} from "@/lib/ai/provider";
import { BANGLISH, BENGALI } from "@/lib/ai/language";

/**
 * The Gemini provider's tests.
 *
 * ── What these tests are really about ─────────────────────────────────────
 *
 * The Gemini provider is tested **without a network call**. The SDK
 * client is injected, so the test can capture the exact request the
 * provider *would* send and assert on its shape.
 *
 * The shape of that request is the contract with the model, and it is
 * the thing most likely to rot:
 *
 *   1. The history is replayed as a **real multi-turn transcript** —
 *      `user` / `model` roles, not a summary pasted into the prompt.
 *   2. The photo rides with the **current** turn, as an `inlineData`
 *      part, at high resolution.
 *   3. The language rule reaches the **system instruction**.
 *   4. The response is **untrusted**: an id outside the allow-list is
 *      dropped, and the service layer's guard rail still holds.
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
 * The parameters the provider handed to the SDK.
 */
type CapturedRequest = {
  model: string;
  contents: Array<{
    role?: string;
    parts?: Array<{
      text?: string;
      inlineData?: { mimeType?: string; data?: string };
    }>;
  }>;
  config?: {
    systemInstruction?: string;
    temperature?: number;
    responseMimeType?: string;
    responseJsonSchema?: unknown;
    mediaResolution?: string;
    tools?: Array<{
      functionDeclarations?: Array<{ name?: string; description?: string }>;
    }>;
    toolConfig?: { functionCallingConfig?: { mode?: string } };
  };
};

/**
 * A stubbed Gemini response.
 *
 * The SDK returns a `GenerateContentResponse`, whose `text` getter
 * concatenates the text parts of the first candidate and whose
 * `functionCalls` getter collects the function-call parts. The stub
 * returns an object with the same shape.
 *
 * A real response can carry **both** — prose and a call — so the stub
 * takes both.
 */
function stubResponse(
  text: string,
  functionCalls?: Array<{ name: string; args?: unknown }>,
): {
  text?: string;
  functionCalls?: Array<{ name: string; args?: unknown }>;
  promptFeedback?: { blockReason?: string };
} {
  return { text, ...(functionCalls ? { functionCalls } : {}) };
}

/**
 * Builds a provider whose SDK client records the request and returns a
 * canned response.
 */
function makeProvider(
  response: { text?: string; promptFeedback?: { blockReason?: string } },
  captured: CapturedRequest[],
): GeminiProvider {
  const client = {
    models: {
      generateContent: async (params: unknown) => {
        captured.push(params as CapturedRequest);

        return response;
      },
    },
  };

  // The cast is deliberate: the stub implements only the part of the
  // SDK surface the provider actually calls. The provider's own
  // constructor signature enforces the rest at compile time.
  return new GeminiProvider({
    client: client as never,
    model: "gemini-3.5-flash",
  });
}

describe("GeminiProvider", () => {
  it("throws when no API key is configured", () => {
    const original = process.env.GEMINI_API_KEY;

    delete process.env.GEMINI_API_KEY;

    try {
      expect(() => new GeminiProvider()).toThrow(AiProviderError);
    } finally {
      if (original !== undefined) process.env.GEMINI_API_KEY = original;
    }
  });

  it("uses the configured model name", () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-3.5-flash",
    });

    expect(provider.modelName).toBe("gemini-3.5-flash");
    expect(provider.name).toBe(GEMINI_PROVIDER_NAME);
  });

  it("falls back to the default model when none is configured", () => {
    const original = process.env.GEMINI_MODEL;

    delete process.env.GEMINI_MODEL;

    try {
      const provider = new GeminiProvider({ apiKey: "test-key" });

      expect(provider.modelName).toBe(DEFAULT_GEMINI_MODEL);
    } finally {
      if (original !== undefined) process.env.GEMINI_MODEL = original;
    }
  });

  it("declares that it can see images", () => {
    const provider = new GeminiProvider({ apiKey: "test-key" });

    // The service layer uses this to decide whether to base64-encode
    // the customer's photograph at all.
    expect(provider.supportsVision).toBe(true);
  });

  describe("the request it sends", () => {
    it("replays the conversation history as real turns", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({
          history: [
            { role: "USER", content: "I have oily skin." },
            { role: "ASSISTANT", content: "Here is a gentle cleanser." },
            { role: "USER", content: "Will this work with the sunscreen?" },
          ],
        }),
      );

      const contents = captured[0]?.contents ?? [];

      // The three history turns, then the current turn.
      expect(contents).toHaveLength(4);

      expect(contents[0]?.role).toBe("user");
      expect(contents[0]?.parts?.[0]?.text).toBe("I have oily skin.");

      // Gemini's assistant role is `model`, not `assistant`.
      expect(contents[1]?.role).toBe("model");
      expect(contents[1]?.parts?.[0]?.text).toBe(
        "Here is a gentle cleanser.",
      );

      expect(contents[2]?.role).toBe("user");
      expect(contents[2]?.parts?.[0]?.text).toBe(
        "Will this work with the sunscreen?",
      );

      expect(contents[3]?.role).toBe("user");
    });

    it("puts the history in chronological order", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({
          history: [
            { role: "USER", content: "First question." },
            { role: "ASSISTANT", content: "First answer." },
            { role: "USER", content: "Second question." },
          ],
        }),
      );

      const contents = captured[0]?.contents ?? [];

      expect(contents[0]?.parts?.[0]?.text).toBe("First question.");
      expect(contents[1]?.parts?.[0]?.text).toBe("First answer.");
      expect(contents[2]?.parts?.[0]?.text).toBe("Second question.");
    });

    it("skips a history turn with no content", async () => {
      // An empty model turn teaches the model that it may answer with
      // nothing.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({
          history: [
            { role: "USER", content: "A real question." },
            { role: "ASSISTANT", content: "   " },
          ],
        }),
      );

      const contents = captured[0]?.contents ?? [];

      expect(contents).toHaveLength(2);
      expect(contents[0]?.parts?.[0]?.text).toBe("A real question.");
    });

    it("sends no history turns when there is no history", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(makeRequest({ history: [] }));

      const contents = captured[0]?.contents ?? [];

      expect(contents).toHaveLength(1);
      expect(contents[0]?.role).toBe("user");
    });

    it("attaches the image to the current turn as inline data", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({ image: { mimeType: "image/jpeg", base64: "AAAA" } }),
      );

      const contents = captured[0]?.contents ?? [];
      const current = contents[contents.length - 1];

      const imagePart = current?.parts?.find(
        (part) => part.inlineData !== undefined,
      );

      expect(imagePart?.inlineData?.mimeType).toBe("image/jpeg");
      expect(imagePart?.inlineData?.data).toBe("AAAA");
    });

    it("tells the model a photo is attached", async () => {
      // A model that does not know a photo is attached will not look at
      // it — it will answer the text and ignore the image.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({ image: { mimeType: "image/jpeg", base64: "AAAA" } }),
      );

      const contents = captured[0]?.contents ?? [];
      const current = contents[contents.length - 1];

      const textPart = current?.parts?.find((part) => part.text !== undefined);

      expect(String(textPart?.text)).toContain("PHOTO ATTACHED");
    });

    it("sends no image part when there is no image", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(makeRequest());

      const contents = captured[0]?.contents ?? [];
      const current = contents[contents.length - 1];

      expect(
        current?.parts?.find((part) => part.inlineData !== undefined),
      ).toBeUndefined();
    });

    it("asks for the photo to be read at high resolution", async () => {
      // The question being asked of the image is "what is happening on
      // this person's skin". A low-resolution thumbnail throws exactly
      // those details away.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({ image: { mimeType: "image/jpeg", base64: "AAAA" } }),
      );

      expect(captured[0]?.config?.mediaResolution).toBe(
        "MEDIA_RESOLUTION_HIGH",
      );
    });

    it("puts the language rule in the system instruction", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(makeRequest({ language: BANGLISH }));

      expect(String(captured[0]?.config?.systemInstruction)).toContain(
        "Banglish",
      );
    });

    it("keeps the hard rules in the system instruction", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(makeRequest());

      const system = String(captured[0]?.config?.systemInstruction);

      // The persona the shop asked for.
      expect(system).toContain("official AI Skincare Advisor");
      expect(system).toContain("Bangladesh");
      // And the rules that keep the model inside the catalogue.
      expect(system).toContain("Never invent a product");
      expect(system).toContain("do not downgrade its severity");
    });

    it("uses the admin's prompt override when there is one", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(makeRequest({ systemPrompt: "Be extremely brief." }));

      expect(String(captured[0]?.config?.systemInstruction)).toContain(
        "Be extremely brief.",
      );
    });

    it("still applies the language rule to an admin's prompt override", async () => {
      // An override replaces the persona, but it must not be able to lose
      // the language behaviour — a customer who writes in Bengali must
      // be answered in Bengali whatever the admin typed.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({ systemPrompt: "Be extremely brief.", language: BENGALI }),
      );

      const system = String(captured[0]?.config?.systemInstruction);

      expect(system).toContain("Be extremely brief.");
      expect(system).toContain("Bengali");
    });

    it("does not constrain the response format", async () => {
      // The advisor used to ask for a strict JSON envelope, and the model
      // obeyed it — which is why every reply had the same shape and the
      // greeting dumped a routine. Free prose is the whole point of the
      // refactor, so there must be no response-format constraint left.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse("Hello! What is your skin type?"),
        captured,
      );

      await provider.complete(makeRequest());

      expect(captured[0]?.config?.responseMimeType).toBeUndefined();
      expect(captured[0]?.config?.responseJsonSchema).toBeUndefined();
    });

    it("offers the model a function for reporting its recommendations", async () => {
      // The ids travel on their own channel, so the prose is free.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse("Hello! What is your skin type?"),
        captured,
      );

      await provider.complete(makeRequest());

      const tools = captured[0]?.config?.tools as
        | Array<{ functionDeclarations?: Array<{ name?: string }> }>
        | undefined;

      const names =
        tools?.[0]?.functionDeclarations?.map((declaration) => declaration.name) ??
        [];

      expect(names).toContain("recommend_products");
    });

    it("asks the model to report its recommendations on a marker line", async () => {
      // The function call is the primary channel, but a model that
      // returns prose and no call still has to be able to say what it
      // recommended. The marker is the fallback, and it is stripped from
      // the prose before the customer sees it.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse("Hello! What is your skin type?"),
        captured,
      );

      await provider.complete(makeRequest());

      const contents = captured[0]?.contents ?? [];
      const current = contents[contents.length - 1];

      const textPart = current?.parts?.find((part) => part.text !== undefined);

      expect(String(textPart?.text)).toContain("[RECOMMENDED:");
    });

    it("puts the candidate list and the skin profile in the brief", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(makeRequest());

      const contents = captured[0]?.contents ?? [];
      const current = contents[contents.length - 1];

      const textPart = current?.parts?.find((part) => part.text !== undefined);
      const brief = String(textPart?.text);

      expect(brief).toContain("CUSTOMER QUESTION:");
      expect(brief).toContain("SKIN PROFILE:");
      expect(brief).toContain("skin type: OILY");
      expect(brief).toContain("CANDIDATES:");
      expect(brief).toContain(NIACINAMIDE_PRODUCT.id);
    });

    /*
     * The turn instruction.
     *
     * These are the tests that matter for the conversational behaviour.
     * A model told only "be helpful" will recommend products on a
     * greeting — a product list is what "helpful" looks like to a
     * model asked about skincare. Told explicitly that this turn is a
     * greeting and that the list must be empty, it behaves.
     */
    it("puts the turn instruction in the system instruction", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Hello!",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({
          userMessage: "hi",
          intent: {
            kind: "GREETING",
            mayRecommend: false,
            mayWarn: false,
            missing: ["SKIN_TYPE", "CONCERNS"],
          },
        }),
      );

      const system = String(captured[0]?.config?.systemInstruction);

      expect(system).toContain("THIS TURN IS A GREETING");
      expect(system).toContain("Recommend nothing on this turn");
    });

    it("tells the model that a greeting turn may not carry products", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Hello!",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({
          intent: {
            kind: "GREETING",
            mayRecommend: false,
            mayWarn: false,
            missing: ["SKIN_TYPE"],
          },
        }),
      );

      const system = String(captured[0]?.config?.systemInstruction);

      expect(system).toContain("Do NOT list any product");
    });

    it("still applies the turn instruction to an admin's prompt override", async () => {
      // An override replaces the persona, but it must not be able to
      // lose the conversational behaviour — the whole point of the
      // advisor is that it behaves like a person.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Hello!",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({
          systemPrompt: "Be extremely brief.",
          intent: {
            kind: "GREETING",
            mayRecommend: false,
            mayWarn: false,
            missing: ["SKIN_TYPE"],
          },
        }),
      );

      const system = String(captured[0]?.config?.systemInstruction);

      expect(system).toContain("Be extremely brief.");
      expect(system).toContain("THIS TURN IS A GREETING");
    });

    it("states the turn's intent in the brief as well", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          "Here you go.",
        ),
        captured,
      );

      await provider.complete(
        makeRequest({
          intent: {
            kind: "GREETING",
            mayRecommend: false,
            mayWarn: false,
            missing: ["SKIN_TYPE", "CONCERNS"],
          },
        }),
      );

      const contents = captured[0]?.contents ?? [];
      const current = contents[contents.length - 1];

      const textPart = current?.parts?.find((part) => part.text !== undefined);
      const brief = String(textPart?.text);

      expect(brief).toContain("THIS TURN:");
      expect(brief).toContain("GREETING");
      expect(brief).toContain("recommendations allowed on this turn: no");
    });
  });

  describe("the response it returns", () => {
    it("returns the model's prose as-is", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse("Here is a suggestion."),
        captured,
      );

      const response = await provider.complete(makeRequest());

      expect(response.content).toBe("Here is a suggestion.");
      expect(response.recommendedProductIds).toEqual([]);
      expect(response.providerName).toBe(GEMINI_PROVIDER_NAME);
      expect(response.modelName).toBe("gemini-3.5-flash");
      expect(response.isMocked).toBe(false);
    });

    it("reads the recommended ids out of the function call", async () => {
      // The ids arrive as arguments to a call the model chose to make —
      // structured, and completely separate from the prose.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse("Here is a suggestion.", [
          {
            name: "recommend_products",
            args: { productIds: [NIACINAMIDE_PRODUCT.id] },
          },
        ]),
        captured,
      );

      const response = await provider.complete(makeRequest());

      expect(response.content).toBe("Here is a suggestion.");
      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    });

    it("reads the recommended ids out of the marker line", async () => {
      // The fallback channel: a model that returns prose and no call
      // still has to be able to say what it recommended.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          `Here is a suggestion.\n\n[RECOMMENDED: ${NIACINAMIDE_PRODUCT.id}]`,
        ),
        captured,
      );

      const response = await provider.complete(makeRequest());

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    });

    it("removes the marker line from the prose the customer sees", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse(
          `Here is a suggestion.\n\n[RECOMMENDED: ${NIACINAMIDE_PRODUCT.id}]`,
        ),
        captured,
      );

      const response = await provider.complete(makeRequest());

      // A customer must never see the machine-readable line.
      expect(response.content).not.toContain("RECOMMENDED");
      expect(response.content).toBe("Here is a suggestion.");
    });

    it("drops a recommended id that is not in the allow-list", async () => {
      // The model can name an id it was never given. It must not reach
      // the customer.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse("Here is a suggestion.", [
          {
            name: "recommend_products",
            args: { productIds: ["prod_not_allowed"] },
          },
        ]),
        captured,
      );

      const response = await provider.complete(
        makeRequest({ allowedProductIds: [NIACINAMIDE_PRODUCT.id] }),
      );

      expect(response.recommendedProductIds).toEqual([]);
    });

    it("keeps a recommended id that is in the allow-list", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        stubResponse("Here is a suggestion.", [
          {
            name: "recommend_products",
            args: { productIds: [NIACINAMIDE_PRODUCT.id] },
          },
        ]),
        captured,
      );

      const response = await provider.complete(
        makeRequest({ allowedProductIds: [NIACINAMIDE_PRODUCT.id] }),
      );

      expect(response.recommendedProductIds).toEqual([
        NIACINAMIDE_PRODUCT.id,
      ]);
    });

    it("throws a provider error when the response is empty", async () => {
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(stubResponse(""), captured);

      await expect(provider.complete(makeRequest())).rejects.toThrow(
        AiProviderError,
      );
    });

    it("reports a safety block differently from an empty response", async () => {
      // A safety block is a normal outcome for a photo of somebody's
      // face — it is not an outage, and whoever is on call needs to be
      // able to tell the two apart.
      const captured: CapturedRequest[] = [];

      const provider = makeProvider(
        { text: "", promptFeedback: { blockReason: "SAFETY" } },
        captured,
      );

      await expect(provider.complete(makeRequest())).rejects.toThrow(
        /declined to answer/i,
      );
    });

    it("throws a provider error when the SDK itself fails", async () => {
      const client = {
        models: {
          generateContent: async () => {
            throw new Error("network down");
          },
        },
      };

      const provider = new GeminiProvider({
        client: client as never,
        model: "gemini-3.5-flash",
      });

      await expect(provider.complete(makeRequest())).rejects.toThrow(
        AiProviderError,
      );
    });
  });

  /**
   * The retry.
   *
   * Gemini's flash tier returns `503 UNAVAILABLE` with *"this model is
   * currently experiencing high demand"* fairly often. That is a
   * **transient** failure — the same request, sent a second later,
   * usually succeeds — and the live smoke test caught one reaching the
   * customer as a hard error.
   *
   * So the provider retries the failures that mean "try again", and
   * does not retry the ones that mean "this will never work".
   */
  describe("the retry", () => {
    /**
     * A provider whose SDK client fails a given number of times before
     * succeeding.
     */
    function makeFlakyProvider(
      failures: Array<{ status: number; message: string }>,
      success: { text?: string },
      attempts: number[],
    ): GeminiProvider {
      let call = 0;

      const client = {
        models: {
          generateContent: async () => {
            attempts.push(call);
            call += 1;

            const failure = failures[call - 1];

            if (failure) {
              const error = new Error(failure.message) as Error & {
                status: number;
              };

              error.name = "ApiError";
              error.status = failure.status;

              throw error;
            }

            return success;
          },
        },
      };

      return new GeminiProvider({
        client: client as never,
        model: "gemini-3.5-flash",
      });
    }

    it("retries a 503 and succeeds", async () => {
      const attempts: number[] = [];

      const provider = makeFlakyProvider(
        [{ status: 503, message: "high demand" }],
        stubResponse(
          "Here you go.",
        ),
        attempts,
      );

      const response = await provider.complete(makeRequest());

      expect(response.content).toBe("Here you go.");
      expect(attempts).toHaveLength(2);
    });

    it("retries a 429 and succeeds", async () => {
      const attempts: number[] = [];

      const provider = makeFlakyProvider(
        [{ status: 429, message: "rate limited" }],
        stubResponse(
          "Here you go.",
        ),
        attempts,
      );

      const response = await provider.complete(makeRequest());

      expect(response.content).toBe("Here you go.");
      expect(attempts).toHaveLength(2);
    });

    it("does not retry a 404 — a closed model will still be closed", async () => {
      const attempts: number[] = [];

      const provider = makeFlakyProvider(
        [{ status: 404, message: "model not found" }],
        stubResponse(
          "unused",
        ),
        attempts,
      );

      await expect(provider.complete(makeRequest())).rejects.toThrow(
        AiProviderError,
      );

      // One attempt. Retrying would only waste the customer's time.
      expect(attempts).toHaveLength(1);
    });

    it("gives up after the attempt cap", async () => {
      const attempts: number[] = [];

      const provider = makeFlakyProvider(
        Array.from({ length: 10 }, () => ({
          status: 503,
          message: "high demand",
        })),
        stubResponse(
          "unused",
        ),
        attempts,
      );

      await expect(provider.complete(makeRequest())).rejects.toThrow(
        AiProviderError,
      );

      // Three attempts, then it gives up.
      expect(attempts).toHaveLength(3);
    });

    it("says which model is unavailable when the model is closed", async () => {
      // A 404 means the deployment is pointed at a model the account
      // cannot use. The message should say so, because that is the fix.
      const attempts: number[] = [];

      const provider = makeFlakyProvider(
        [{ status: 404, message: "no longer available to new users" }],
        stubResponse(
          "unused",
        ),
        attempts,
      );

      await expect(provider.complete(makeRequest())).rejects.toThrow(
        /gemini-3\.5-flash/,
      );
    });

    it("says the key was rejected when the key is wrong", async () => {
      const attempts: number[] = [];

      const provider = makeFlakyProvider(
        [{ status: 401, message: "API key not valid" }],
        stubResponse(
          "unused",
        ),
        attempts,
      );

      await expect(provider.complete(makeRequest())).rejects.toThrow(
        /API key/i,
      );
    });
  });
});
