import {
  AiProviderError,
  type AdvisorRequest,
  type AdvisorResponse,
  type AiProvider,
} from "./provider";

import {
  ADVISOR_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  MAX_COMPLETION_TOKENS,
  RECOMMEND_PRODUCTS_TOOL,
  buildChatMessages,
  readChatCompletionContent,
  toAdvisorResponse,
  type ChatCompletionResponse,
} from "./openai-compatible";

/**
 * The real OpenAI provider.
 *
 * ── Design notes ─────────────────────────────────────────────────────────
 *
 * • **No SDK.** This talks to the OpenAI REST API with the platform's
 *   `fetch`. The `openai` npm package is a large dependency that adds
 *   nothing here — one endpoint, one request shape, one response shape.
 *   It also keeps the dependency list honest for a project that must run
 *   with no external calls at all in mock mode.
 *
 * • **The dialect is shared with OpenRouter.** The message building, the
 *   prompt assembly, the image format and the reply parsing all live in
 *   `src/lib/ai/openai-compatible.ts`. OpenRouter speaks the same
 *   OpenAI chat-completions dialect, so writing the protocol twice
 *   would have produced two copies of the advisor's *behaviour* — and
 *   they would have drifted.
 *
 * • **Never imported at module scope when the flag is off.** The provider
 *   module itself is only imported by `src/lib/ai/index.ts` inside the
 *   `AI_PROVIDER === "openai"` branch, using a dynamic `import()`. In
 *   mock mode the module is never evaluated, so nothing OpenAI-related
 *   is loaded.
 *
 * • **The model speaks in plain prose.** The request used to carry
 *   `response_format: { type: "json_schema", … }`, which told the model
 *   to answer inside a JSON envelope. It did, dutifully — and every
 *   reply had the same shape, which is exactly the robotic quality this
 *   refactor removes. There is now no response format at all: the
 *   advisor writes prose, and the product ids come back on the marker
 *   line that `src/lib/ai/free-text.ts` strips before the customer sees
 *   it.
 *
 * • **The response is still untrusted.** The model can return an id that
 *   was never a candidate, or a severity it invented. The service layer
 *   validates ids against the allow-list and re-attaches the code-decided
 *   conflicts after this returns. The model cannot widen its own
 *   permissions.
 */

/**
 * The provider name recorded on messages.
 */
export const OPENAI_PROVIDER_NAME = "openai";

/**
 * The default model, used when `OPENAI_MODEL` is not set.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/**
 * The OpenAI API base URL.
 *
 * The path is appended by the request, so a compatible gateway can be
 * pointed at with a different `baseUrl`.
 */
export const OPENAI_BASE_URL = "https://api.openai.com";

/**
 * The path of the chat-completions endpoint.
 */
export const OPENAI_CHAT_PATH = "/v1/chat/completions";

/**
 * Options for the OpenAI provider.
 */
export type OpenAiProviderOptions = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
};

/**
 * The real OpenAI provider.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = OPENAI_PROVIDER_NAME;
  readonly modelName: string;

  /**
   * The OpenAI chat-completions API takes an image inline as a data
   * URL, so this provider can look at the customer's photograph.
   */
  readonly supportsVision = true;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: OpenAiProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

    if (!apiKey || apiKey.trim().length === 0) {
      throw new AiProviderError(
        OPENAI_PROVIDER_NAME,
        "AI_PROVIDER=openai requires OPENAI_API_KEY to be set.",
      );
    }

    this.apiKey = apiKey.trim();
    this.modelName =
      options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
  }

  /**
   * Sends the request to OpenAI and returns the parsed response.
   */
  async complete(request: AdvisorRequest): Promise<AdvisorResponse> {
    const body = {
      model: this.modelName,
      messages: buildChatMessages(request),
      temperature: ADVISOR_TEMPERATURE,
      /*
       * The reply's ceiling.
       *
       * The request states its own size rather than letting the model
       * use as much as its context window allows. On OpenRouter that
       * difference is the difference between a request that runs and
       * one that is refused for exceeding the account's credit — the
       * provider reserves against the model's maximum context window
       * when no ceiling is given.
       */
      max_tokens: MAX_COMPLETION_TOKENS,
      /*
       * The tool the model calls to report what it recommended.
       *
       * The marker line alone is not enough — it was measured being
       * dropped in roughly a third of live conversation turns, and a
       * dropped marker means no product cards in the shop. The tool
       * call is the structured channel, and it is read alongside the
       * marker rather than instead of it.
       */
      tools: [RECOMMEND_PRODUCTS_TOOL],
      /*
       * No `response_format`.
       *
       * The advisor used to ask for a strict JSON schema, and the model
       * obeyed it — which meant every reply had the same shape and the
       * customer's question was answered inside a string field. Free
       * prose is the point of this refactor: the reply should read like
       * something a person wrote.
       *
       * `tool_choice` is left at its default (`auto`), so the model
       * writes the prose and calls the tool only when it has something
       * to report.
       */
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${OPENAI_CHAT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;

      throw new AiProviderError(
        this.name,
        aborted
          ? `The AI provider did not respond within ${this.timeoutMs}ms.`
          : "Could not reach the AI provider.",
        error,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // The error body may contain the reason; it is logged, never returned
      // to the customer.
      const detail = await response.text().catch(() => "");

      console.error(
        `[ai] OpenAI request failed with status ${response.status}:`,
        detail.slice(0, 2000),
      );

      throw new AiProviderError(
        this.name,
        `The AI provider returned an error (HTTP ${response.status}).`,
      );
    }

    const payload = (await response.json()) as ChatCompletionResponse;

    const candidates = request.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
    }));

    const read = readChatCompletionContent(payload, candidates);

    if (!read.ok) {
      throw new AiProviderError(this.name, read.message);
    }

    return toAdvisorResponse(
      read.content,
      request,
      this.name,
      this.modelName,
      read.functionCallIds,
    );
  }
}
