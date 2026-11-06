import { MockProvider } from "./mock-provider";
import type { AiProvider } from "./provider";

/**
 * Provider selection.
 *
 * The `AI_PROVIDER` environment variable chooses the implementation:
 *
 *   • `mock`      — the deterministic offline provider. The default. No API
 *                   key, no network, byte-identical output for identical
 *                   input.
 *   • `openai`    — the real OpenAI provider. Requires `OPENAI_API_KEY`.
 *   • `gemini`    — the real Google Gemini provider. Requires `GEMINI_API_KEY`.
 *   • `openrouter` — the real OpenRouter provider. Requires
 *                   `OPENROUTER_API_KEY`. OpenRouter is a *router* in front
 *                   of many upstream providers, so a request that one
 *                   provider is rate-limiting is routed to one that is not.
 *
 * The real-provider modules are loaded with a **dynamic import** inside the
 * branch, so in mock mode they are never evaluated. That matters because
 * importing one would pull the provider code — and its SDK, and its
 * configuration checks — into every request, including the ones that must
 * work with no external dependency at all.
 *
 * ── Why the providers share one contract ─────────────────────────────────
 *
 * Every real provider implements the same `AiProvider` interface and is
 * handed the same already-filtered candidate list, the same code-decided
 * conflicts and the same allow-list. Switching `AI_PROVIDER` therefore
 * swaps the *phrasing* of the advice and nothing else — the conflict
 * engine, the allow-list validation and the disclaimer behave identically
 * whichever provider is live. That is what makes "code decides, the model
 * phrases" a property of the system rather than of one provider.
 */

export * from "./provider";
export { MockProvider, MOCK_PROVIDER_NAME, MOCK_MODEL_NAME } from "./mock-provider";
export { OpenAiProvider, OPENAI_PROVIDER_NAME } from "./openai-provider";

/*
 * The OpenRouter provider is exported **as types only**, for the same
 * reason the Gemini provider is.
 *
 * A static `export { OpenRouterProvider } from "./openrouter-provider"`
 * would evaluate that module whenever anything imported this one. The
 * module itself is cheap — it uses the platform's `fetch` and no SDK —
 * but the rule is the rule: the real providers are reached through the
 * dynamic `import()` below, so that nothing provider-specific is
 * evaluated in mock mode.
 *
 * A `export type` is erased at compile time, so it carries the names
 * without pulling the module in.
 */
export type {
  OpenRouterProviderOptions,
} from "./openrouter-provider";

/*
 * The Gemini provider is exported **as types only**.
 *
 * A static `export { GeminiProvider } from "./gemini-provider"` would
 * evaluate that module whenever anything imported this one — which means
 * the `@google/genai` SDK would be loaded in mock mode too, the exact
 * thing the lazy `import()` below exists to prevent.
 *
 * A `export type` is erased at compile time, so it carries the names
 * without pulling the module in. The runtime class is reached through
 * the dynamic `import()` in `getAiProvider()`, and directly by anyone
 * who imports `src/lib/ai/gemini-provider` by path.
 */
export type {
  GeminiProviderOptions,
} from "./gemini-provider";

/**
 * The supported provider identifiers.
 */
export type AiProviderName = "mock" | "openai" | "gemini" | "openrouter";

/**
 * The provider used when `AI_PROVIDER` is unset or unrecognised.
 */
export const DEFAULT_AI_PROVIDER: AiProviderName = "mock";

/**
 * Reads the configured provider name.
 *
 * An unrecognised value falls back to `mock` rather than throwing. A typo
 * in a deployment variable should degrade to a working offline provider, not
 * take the storefront down — and it logs loudly so the typo is noticed.
 */
export function getAiProviderName(): AiProviderName {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();

  if (!raw || raw === "mock") return "mock";

  if (raw === "openai") return "openai";

  if (raw === "gemini") return "gemini";

  if (raw === "openrouter") return "openrouter";

  console.warn(
    `[ai] Unrecognised AI_PROVIDER="${raw}". Falling back to "${DEFAULT_AI_PROVIDER}".`,
  );

  return DEFAULT_AI_PROVIDER;
}

/**
 * Returns the provider for the current environment.
 *
 * @throws when a real provider is selected but its API key is missing.
 *         This is a deployment error, and failing loudly at the point of
 *         use is correct — silently falling back to the mock would let a
 *         staging deployment look healthy while producing canned advice.
 */
export async function getAiProvider(): Promise<AiProvider> {
  const name = getAiProviderName();

  if (name === "openai") {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error(
        "AI_PROVIDER=openai requires OPENAI_API_KEY to be set.",
      );
    }

    // Loaded lazily — see the module note above.
    const { OpenAiProvider } = await import("./openai-provider");

    return new OpenAiProvider();
  }

  if (name === "gemini") {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error(
        "AI_PROVIDER=gemini requires GEMINI_API_KEY to be set.",
      );
    }

    // Loaded lazily — see the module note above. The `@google/genai`
    // SDK is never evaluated in mock mode.
    const { GeminiProvider } = await import("./gemini-provider");

    return new GeminiProvider();
  }

  if (name === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      throw new Error(
        "AI_PROVIDER=openrouter requires OPENROUTER_API_KEY to be set.",
      );
    }

    // Loaded lazily — see the module note above. Nothing OpenRouter-
    // specific is evaluated in mock mode.
    const { OpenRouterProvider } = await import("./openrouter-provider");

    return new OpenRouterProvider();
  }

  return new MockProvider();
}

/**
 * Returns the provider synchronously.
 *
 * Only safe for the mock provider, which is importable without side
 * effects. The OpenAI provider needs a dynamic import, so a synchronous
 * getter cannot return it — use `getAiProvider()` for that.
 */
export function getMockProvider(): AiProvider {
  return new MockProvider();
}
