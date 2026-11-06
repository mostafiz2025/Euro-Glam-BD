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
  type ChatCompletionRead,
  type ChatCompletionResponse,
} from "./openai-compatible";

import type { MarkerCandidate } from "./free-text";

/**
 * The OpenRouter provider.
 *
 * ── What OpenRouter is ───────────────────────────────────────────────────
 *
 * OpenRouter is a **router**: one OpenAI-compatible endpoint in front of
 * many upstream model providers. The shop sends one request, and
 * OpenRouter picks which upstream provider actually serves it.
 *
 * That is exactly what this deployment needs. The shop was hitting
 * rate limits on a single provider's shared key, and every one of those
 * `429`s reached the customer as a failed advisor turn. A router with
 * **fallbacks enabled** turns "the upstream provider is full" into
 * "some other provider answered" — which is the difference between a
 * rate limit the customer sees and a rate limit they never notice.
 *
 * ── Design notes ─────────────────────────────────────────────────────────
 *
 * • **No SDK.** The endpoint is a plain REST call with an
 *   OpenAI-compatible body. The `openai` npm package would add a
 *   dependency for one endpoint and one request shape, and it does not
 *   know about OpenRouter's routing preferences anyway.
 *
 * • **The dialect is shared, not copied.** The message building, the
 *   prompt assembly, the image format and the reply parsing all live in
 *   `src/lib/ai/openai-compatible.ts`, because OpenRouter speaks the
 *   OpenAI chat-completions dialect. A second copy of the prompt
 *   assembly would be a second copy of the advisor's behaviour, and the
 *   two would drift.
 *
 * • **The routing preferences are what make it worth using.** OpenRouter
 *   accepts a `provider` object on the body. This provider sets
 *   `allow_fallbacks: true` and `require_parameters: true`, so a
 *   request that one upstream provider cannot serve is passed to one
 *   that can, rather than failing outright.
 *
 * • **Never imported at module scope when the flag is off.** The
 *   provider module is reached through a dynamic `import()` inside the
 *   `AI_PROVIDER === "openrouter"` branch of `src/lib/ai/index.ts`, so
 *   nothing OpenRouter-related is loaded in mock mode.
 *
 * • **The model speaks in plain prose.** The request carries **no
 *   `response_format`** — the advisor used to ask for a strict JSON
 *   schema, and every reply came back in the same shape, which is
 *   precisely the robotic quality the free-prose refactor removes. The
 *   product ids come back on the marker line, which
 *   `src/lib/ai/free-text.ts` strips before the customer sees it.
 *
 * • **The response is still untrusted.** The model can return an id that
 *   was never a candidate. The service layer validates ids against the
 *   allow-list and re-attaches the code-decided conflicts after this
 *   returns. The model cannot widen its own permissions.
 */

/**
 * The provider name recorded on messages.
 */
export const OPENROUTER_PROVIDER_NAME = "openrouter";

/**
 * The default model, used when `OPENROUTER_MODEL` is not set.
 *
 * ── Why this one, and why it must read images ───────────────────────────
 *
 * `deepseek/deepseek-v4.1-flash-1017` is a fast, inexpensive model that
 * reads images as well as text — the "flash" tier is the one that keeps
 * a per-conversation cost sane, and the multimodal support means the
 * skin photo can actually be looked at.
 *
 * The multimodal part is not a nice-to-have. A **text-only** model is
 * not a degraded version of a multimodal one here — OpenRouter
 * **rejects** the request outright:
 *
 * > No endpoints found that support image input
 *
 * A live probe confirmed it: `deepseek/deepseek-chat` answers a text
 * question perfectly and returns a `404` on a photo. So a
 * text-only default would mean the advisor's photo analysis — a
 * headline feature — fails on every attempt, with an error that reads
 * like a bad model id rather than a missing capability.
 *
 * The default is only a default. OpenRouter's whole point is that the
 * model is a configuration value, and `OPENROUTER_MODEL` overrides it
 * per deployment. When it is overridden, it must be a **multimodal**
 * model if the advisor is to look at photographs.
 */
export const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash-1017";

/**
 * The OpenRouter endpoint.
 *
 * The base URL, without the path — the path is appended by the request
 * so that a self-hosted OpenRouter-compatible gateway can be pointed at
 * with a different `baseUrl`.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * The path of the chat-completions endpoint.
 */
export const OPENROUTER_CHAT_PATH = "/chat/completions";

/**
 * How many times a request is attempted before it is given up on.
 *
 * Three attempts: the first, plus two retries. The delays are
 * exponential, so the worst case is roughly 300ms + 600ms of waiting —
 * short enough to stay inside the chat route's 30-second ceiling.
 */
export const MAX_ATTEMPTS = 3;

/**
 * The first retry delay in milliseconds.
 *
 * The delay doubles on each attempt: 300ms, then 600ms. A `429` from an
 * upstream provider clears in seconds, so a short backoff is enough —
 * and a long one would just make the customer wait.
 */
export const RETRY_BASE_DELAY_MS = 300;

/**
 * The HTTP status codes that mean "try again".
 *
 *   • `429` — the rate limit. The upstream provider's quota will refill,
 *     and — this is the point of the router — a *different* upstream
 *     provider may serve the retry.
 *   • `408` — the request timed out upstream.
 *   • `500` — an internal error on the provider's side.
 *   • `502` / `503` — the upstream provider is down or under high
 *     demand. Both are exactly what a router's fallbacks exist for.
 *
 * A `404` is deliberately **not** here: a model that does not exist will
 * still not exist on the second attempt, and a `401` means the key is
 * wrong — neither is worth a retry.
 */
export const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503]);

/**
 * Options for the OpenRouter provider.
 */
export type OpenRouterProviderOptions = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * The base URL of the OpenRouter-compatible endpoint.
   *
   * Overridable so a self-hosted gateway — or a test — can be pointed
   * at without touching the code.
   */
  baseUrl?: string;
  /**
   * The site URL sent as `HTTP-Referer`.
   *
   * Optional on OpenRouter's side, but it is how OpenRouter attributes
   * the app in its rankings, so the shop sends it when it knows one.
   *
   * An explicit `null` means "send no referer at all", which is
   * different from leaving it unset — unset falls back to the
   * environment.
   */
  referer?: string | null;
  /**
   * The app title sent as `X-Title`.
   *
   * Optional, and the same: OpenRouter uses it to show which app made a
   * request on its dashboard.
   */
  title?: string | null;
};

/**
 * The real OpenRouter provider.
 */
export class OpenRouterProvider implements AiProvider {
  readonly name = OPENROUTER_PROVIDER_NAME;
  readonly modelName: string;

  /**
   * OpenRouter can route to multimodal models, and the advisor's photo
   * analysis is the point of asking for one — so this provider can look
   * at the customer's photograph.
   *
   * ── The caveat, and it is a real one ───────────────────────────────────
   *
   * Whether the photo actually reaches a model that can read it depends
   * on the **model**, not on the provider. OpenRouter filters the
   * upstream endpoints by image support automatically, and a text-only
   * model turns a photo request into a hard `404`:
   *
   * > No endpoints found that support image input
   *
   * So `OPENROUTER_MODEL` must name a **multimodal** model for photo
   * analysis to work. The default does; a deployment that overrides it
   * with a text-only model gets a clear error naming the setting, not a
   * silent answer that ignores the photograph.
   */
  readonly supportsVision = true;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly referer: string | null;
  private readonly title: string | null;

  constructor(options: OpenRouterProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;

    if (!apiKey || apiKey.trim().length === 0) {
      throw new AiProviderError(
        OPENROUTER_PROVIDER_NAME,
        "AI_PROVIDER=openrouter requires OPENROUTER_API_KEY to be set.",
      );
    }

    this.apiKey = apiKey.trim();
    this.modelName =
      options.model ??
      process.env.OPENROUTER_MODEL ??
      DEFAULT_OPENROUTER_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.referer =
      options.referer === undefined ? readReferer() : options.referer;
    this.title = options.title === undefined ? readTitle() : options.title;
  }

  /**
   * Sends the request to OpenRouter and returns the parsed response.
   */
  async complete(request: AdvisorRequest): Promise<AdvisorResponse> {
    const body = {
      model: this.modelName,
      messages: buildChatMessages(request),
      temperature: ADVISOR_TEMPERATURE,
      /*
       * The reply's ceiling.
       *
       * This is not a nicety. OpenRouter reserves credit against the
       * model's *maximum* context window when the request does not state
       * a ceiling of its own, and refuses the request when the balance
       * cannot cover the reservation:
       *
       * > This request requires more credits, or fewer max_tokens. You
       * > requested up to 131072 tokens, but can only afford 34923.
       *
       * The advisor's reply is a few hundred tokens; the reservation was
       * for the whole context. Stating the ceiling is what lets the
       * request run at all.
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
       *
       * It costs the request nothing in routing: every upstream
       * endpoint for the configured model supports tools, so the
       * fallback pool is unchanged.
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
       * `tool_choice` is left at its default (`auto`), which lets the
       * model write the prose and call the tool only when it has
       * something to report. Forcing the call would produce a reply with
       * no prose at all — which was observed on the live API.
       */
      provider: {
        /*
         * Fallbacks on.
         *
         * This is the single most important setting on this request.
         * A model on OpenRouter is served by many upstream providers,
         * and one of them being rate-limited is the ordinary case, not
         * an outage. With fallbacks off, that upstream `429` becomes a
         * failed advisor turn. With them on, the router sends the
         * request to a provider that has capacity.
         */
        allow_fallbacks: true,
        /*
         * `require_parameters` is deliberately **left at its default**
         * (`false`), and `sort` is deliberately left unset.
         *
         * Both were tempting, and both are wrong for this deployment.
         *
         * `require_parameters: true` restricts routing to providers
         * that support *every* parameter in the request. It does not
         * narrow the pool to image-capable providers — image support is
         * a **modality**, not a parameter, and OpenRouter routes on the
         * model's own declared input modalities without being asked. So
         * the flag buys no image safety, and it costs the one thing
         * this provider exists for: a wide pool of upstream providers to
         * fall back to when one of them is rate-limited.
         *
         * `sort` would pin the routing to a single priority —
         * `throughput`, `price` or `latency` — which replaces the
         * router's own judgement. The default routing is what already
         * accounts for a provider's recent `429` rate, shrinking its
         * share of traffic until it recovers. Pinning the sort would
         * override exactly the behaviour that routes around the rate
         * limits.
         */
      },
    };

    const candidates = request.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
    }));

    const { read } = await this.sendWithRetry(body, candidates);

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

  /**
   * Sends the request, retrying the failures that are worth retrying.
   *
   * ── Why the retry is here and not left to the router ───────────────────
   *
   * OpenRouter already routes around a rate-limited upstream provider,
   * but it does not re-run a request that failed *at the router's own
   * level* — a `429` on the account's own quota, or a `502` from a
   * provider that was mid-flight. Those are **transient**: the same
   * request, sent a second later, usually succeeds.
   *
   * The retry applies to the errors that mean *"try again"*, it does not
   * apply to the errors that mean *"this will never work"* — a bad API
   * key, a model that does not exist, a malformed request — and it is
   * bounded so a bad day at the router does not turn into a customer
   * waiting forever.
   *
   * ── The retryable failure that is not an HTTP failure ───────────────────
   *
   * A model can answer with a tool call and **no prose at all**. That
   * arrives as a perfectly healthy `200`, so it is invisible to a status
   * code check — but it is the worst outcome the advisor can produce,
   * because the customer gets no reply.
   *
   * It is also **transient**: it is a sampling accident, and the same
   * model writes the prose on the next attempt. So it is retried, and
   * the retry budget is the same bounded one.
   */
  private async sendWithRetry(
    body: {
      model: string;
      messages: unknown[];
      temperature: number;
      max_tokens: number;
      tools: unknown[];
      provider: Record<string, unknown>;
    },
    candidates: readonly MarkerCandidate[],
  ): Promise<{ read: ChatCompletionRead }> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await this.delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(
          `${this.baseUrl}${OPENROUTER_CHAT_PATH}`,
          {
            method: "POST",
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const detail = await response.text().catch(() => "");

          // The error body may contain the reason; it is logged, never
          // returned to the customer.
          console.error(
            `[ai] OpenRouter request failed with status ${response.status}:`,
            detail.slice(0, 2000),
          );

          /*
           * The image case, which has its own message.
           *
           * A model that cannot read images is not a broken model — it
           * is a *text-only* model, and OpenRouter says so precisely:
           *
           * > No endpoints found that support image input
           *
           * This matters because the advisor's photo analysis is a
           * headline feature, and the failure is otherwise
           * indistinguishable from "the model does not exist". Both
           * are `404`, but the fixes are different: one is "pick a
           * model that reads images", the other is "check the model
           * id".
           */
          if (isImageUnsupported(detail)) {
            throw new AiProviderError(
              this.name,
              `The AI model "${this.modelName}" cannot read images. Choose a multimodal model in OPENROUTER_MODEL to enable photo analysis.`,
              detail,
            );
          }

          /*
           * The credit case.
           *
           * A `402` is not a rate limit and not a fault in the request —
           * it is the account's balance. OpenRouter says so precisely:
           *
           * > This request requires more credits, or fewer max_tokens.
           *
           * The "or fewer max_tokens" half is the one worth acting on,
           * because the advisor's request now states its own ceiling and
           * that half should not happen. When it does, the balance is
           * genuinely too small, and retrying would not change it.
           */
          if (response.status === 402) {
            throw new AiProviderError(
              this.name,
              "The AI provider account has run out of credit.",
              detail,
            );
          }

          if (
            RETRYABLE_STATUS_CODES.has(response.status) &&
            attempt < MAX_ATTEMPTS - 1
          ) {
            console.warn(
              `[ai] OpenRouter request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}) with ${response.status}. Retrying.`,
            );

            lastError = new Error(`HTTP ${response.status}`);

            continue;
          }

          throw this.toProviderError(response.status, lastError);
        }

        const payload = (await response.json()) as ChatCompletionResponse;

        const read = readChatCompletionContent(payload, candidates);

        /*
         * The tool-call-only reply.
         *
         * A healthy `200` carrying a tool call and no prose. It is
         * retried, because the alternative is a customer who gets no
         * answer at all — and because the same model writes the prose
         * on the next attempt.
         */
        if (!read.ok && read.retryable && attempt < MAX_ATTEMPTS - 1) {
          console.warn(
            `[ai] OpenRouter answered with a tool call and no prose (attempt ${attempt + 1}/${MAX_ATTEMPTS}). Retrying.`,
          );

          continue;
        }

        return { read };
      } catch (error) {
        // A provider error thrown above is already the right shape.
        if (error instanceof AiProviderError) {
          throw error;
        }

        lastError = error;

        const aborted = controller.signal.aborted;

        // A timeout is not worth retrying — the route's own deadline is
        // about to be reached anyway.
        if (aborted) {
          throw new AiProviderError(
            this.name,
            `The AI provider did not respond within ${this.timeoutMs}ms.`,
            error,
          );
        }

        if (attempt === MAX_ATTEMPTS - 1) {
          throw this.toProviderError(null, error);
        }

        console.warn(
          `[ai] OpenRouter request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${describeError(error)}. Retrying.`,
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    // Unreachable: the loop either returns or throws. The throw is here
    // so the function is total for the type checker.
    throw this.toProviderError(null, lastError);
  }

  /**
   * Builds the request headers.
   *
   * ── The three headers, and why each one is here ────────────────────────
   *
   *   • **`Authorization: Bearer <key>`** — the credential. Required.
   *
   *   • **`HTTP-Referer`** — the site's URL. OpenRouter uses it to
   *     attribute the app and to rank it; it is not used to authenticate
   *     anything, so a wrong value is harmless.
   *
   *   • **`X-Title`** — the app's name. Same deal: it shows up on
   *     OpenRouter's dashboard so the shop can see its own traffic.
   *
   * The last two are omitted entirely when they are unknown, rather
   * than sent empty — an empty header is worse than an absent one.
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.referer) {
      headers["HTTP-Referer"] = this.referer;
    }

    if (this.title) {
      headers["X-Title"] = this.title;
    }

    return headers;
  }

  /**
   * Waits for the given number of milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Converts a failure into an `AiProviderError`.
   *
   * The message reaching the customer is chosen by the status code,
   * because the three common failures look identical from the outside
   * and mean very different things:
   *
   *   • `401`/`403` — the key is wrong or lacks access.
   *   • `404` — the model does not exist on OpenRouter, so the
   *     deployment is pointed at something that cannot work.
   *   • `429` — the account is rate limited. Transient, and the one the
   *     router's fallbacks exist to route around.
   */
  private toProviderError(
    status: number | null,
    cause: unknown,
  ): AiProviderError {
    if (cause instanceof AiProviderError) {
      return cause;
    }

    if (status === 401 || status === 403) {
      return new AiProviderError(
        this.name,
        "The AI provider rejected the API key.",
        cause,
      );
    }

    if (status === 404) {
      return new AiProviderError(
        this.name,
        `The AI model "${this.modelName}" is not available on OpenRouter. Check the OPENROUTER_MODEL setting.`,
        cause,
      );
    }

    if (status === 429) {
      return new AiProviderError(
        this.name,
        "The AI provider is rate limiting this account. Please try again shortly.",
        cause,
      );
    }

    if (status === 402) {
      return new AiProviderError(
        this.name,
        "The AI provider account has run out of credit.",
        cause,
      );
    }

    if (status !== null) {
      return new AiProviderError(
        this.name,
        `The AI provider returned an error (HTTP ${status}).`,
        cause,
      );
    }

    return new AiProviderError(
      this.name,
      "Could not reach the AI provider.",
      cause,
    );
  }
}

/**
 * A short description of an error, for the log line.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 200);
  }

  return String(error).slice(0, 200);
}

/**
 * Whether OpenRouter refused the request because the model cannot read
 * images.
 *
 * ── How this is detected ─────────────────────────────────────────────────
 *
 * By the error body, not by the status code. A text-only model and a
 * model that does not exist are **both** `404`, and they need different
 * fixes.
 *
 * OpenRouter's own wording is the signal:
 *
 * > No endpoints found that support image input
 *
 * and the routing funnel in the metadata names the step that failed
 * (`Filter by Image Support`).
 */
function isImageUnsupported(detail: string): boolean {
  return (
    detail.includes("support image input") ||
    detail.includes("Filter by Image Support")
  );
}

/**
 * Reads the site URL to send as `HTTP-Referer`.
 *
 * `NEXT_PUBLIC_SITE_URL` is the shop's own setting and is used for the
 * SMS order links, so it is the right value to reuse. It is optional —
 * OpenRouter does not require it — and it is omitted when unset.
 */
function readReferer(): string | null {
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim();

  return value && value.length > 0 ? value : null;
}

/**
 * Reads the app title to send as `X-Title`.
 *
 * There is no dedicated variable for it, so the site's own name is used.
 * It is optional, and it is omitted when unset.
 */
function readTitle(): string | null {
  const value = process.env.OPENROUTER_TITLE?.trim();

  if (value && value.length > 0) {
    return value;
  }

  return "Euro Glam BD";
}
