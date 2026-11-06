import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  MediaResolution,
  Type,
  type Content,
  type GenerateContentResponse,
  type Part,
  type Tool,
} from "@google/genai";

import {
  DEFAULT_SYSTEM_PROMPT,
  describeCandidates,
  describeConflicts,
  resolveAllowedIds,
  AiProviderError,
  type AdvisorRequest,
  type AdvisorResponse,
  type AiProvider,
} from "./provider";

import { ENGLISH, describeAdvisorLanguage } from "./language";
import { describeAdvisorIntent } from "./intent";
import {
  parseFreeTextReply,
  parseFunctionCallIds,
} from "./free-text";

/**
 * The Google Gemini provider.
 *
 * ── Design notes ─────────────────────────────────────────────────────────
 *
 * • **It sits behind the same `AiProvider` seam as the OpenAI provider.**
 *   The advisor's contract is "code decides, the model phrases", and that
 *   contract is enforced in `src/lib/ai/service.ts` — not in any one
 *   provider. Gemini is therefore a *swap*, not a fork: the candidate
 *   list, the conflict engine, the allow-list validation and the
 *   disclaimer all behave identically whichever provider is active.
 *
 * • **The SDK is loaded lazily.** `src/lib/ai/index.ts` reaches this file
 *   through a dynamic `import()` inside the `AI_PROVIDER === "gemini"`
 *   branch, so the SDK is never evaluated in mock mode — the same rule
 *   the OpenAI provider follows.
 *
 * • **The model speaks in plain prose.** There is no `responseMimeType`
 *   and no `responseJsonSchema` — the advisor used to ask for a strict
 *   JSON envelope, and a model told to produce a JSON envelope produces
 *   a JSON envelope: the customer's question answered in whatever room
 *   was left over inside `{"content": "…"}`. The reply now has no format
 *   constraint at all, so it can be a greeting, an explanation, or a
 *   paragraph of advice, written the way a person would write it.
 *
 * • **The product ids travel on their own channel.** Free prose cannot
 *   carry machine-readable ids reliably, so the ids come back through
 *   Gemini's function calling — the model names the products it
 *   recommended in a `recommend_products` call alongside its reply. The
 *   provider also reads the `[RECOMMENDED: …]` marker line, because a
 *   model that returns prose and *no* call still has to be able to say
 *   what it recommended. Both channels are parsed by
 *   `src/lib/ai/free-text.ts`, and both are untrusted: the service layer
 *   validates every id against the allow-list.
 *
 * • **The response is still untrusted.** The service layer validates the
 *   ids against the allow-list and re-attaches the code-decided conflicts
 *   after this returns. The model cannot widen its own permissions.
 */

/**
 * The provider name recorded on messages.
 */
export const GEMINI_PROVIDER_NAME = "gemini";

/**
 * The default model, used when `GEMINI_MODEL` is not set.
 *
 * `gemini-3.5-flash` is the workhorse: it is multimodal (so the skin
 * photo can actually be looked at), fast enough for a chat turn, and
 * cheap enough to run per-conversation.
 *
 * ── Why not `gemini-2.5-flash` ───────────────────────────────────────────
 *
 * It was the obvious choice, and it was the default until a live call
 * against a real key returned `404`:
 *
 * > This model models/gemini-2.5-flash is no longer available to new
 * > users.
 *
 * The model is still *listed* by the API, which is what makes this
 * worth writing down: a model that appears in `models.list` can still
 * be closed to the account making the call. The live smoke test
 * (`scripts/verify-gemini.ts`) is what caught it — the unit tests
 * inject a stubbed client and never reach the network.
 *
 * `gemini-3.5-flash` is a stable, non-preview release that is available
 * to new users. A `-preview` suffix means a model can be withdrawn with
 * no notice, so a stable release is the right default for a deployment.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/**
 * The default request timeout in milliseconds.
 *
 * A provider call sits in front of a user waiting for a reply. The chat
 * route allows 30 seconds; this is deliberately shorter so the route can
 * return a clean 502 rather than being killed by the platform timeout
 * with no error message.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How many times a request is attempted before it is given up on.
 *
 * Three attempts: the first, plus two retries. The delays are
 * exponential, so the worst case is roughly 300ms + 600ms of waiting —
 * short enough to stay inside the chat route's 30-second ceiling.
 */
const MAX_ATTEMPTS = 3;

/**
 * The first retry delay in milliseconds.
 *
 * The delay doubles on each attempt: 300ms, then 600ms. Gemini's
 * high-demand `503`s clear in seconds, so a short backoff is enough —
 * and a long one would just make the customer wait.
 */
const RETRY_BASE_DELAY_MS = 300;

/**
 * The HTTP status codes that mean "try again".
 *
 *   • `429` — the rate limit. The quota will refill.
 *   • `500` — an internal error on Google's side.
 *   • `503` — the model is under high demand, or briefly unavailable.
 *
 * A `404` is deliberately **not** here: a closed model will still be
 * closed on the second attempt, and retrying it only wastes the
 * customer's time.
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

/**
 * Reads an HTTP status code out of a provider error.
 *
 * The SDK's `ApiError` carries `status`; a plain `Error` from the
 * network layer does not.
 */
function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const status = (error as { status?: unknown }).status;

  return typeof status === "number" ? status : null;
}

/**
 * Whether a failure is worth retrying.
 */
function isRetryable(error: unknown): boolean {
  const status = statusOf(error);

  if (status !== null) {
    return RETRYABLE_STATUS_CODES.has(status);
  }

  /*
   * A network-level failure has no status. It is still worth retrying —
   * a dropped connection is the definition of transient — but a
   * programming error (a `TypeError`, say) is not, and retrying it
   * three times only delays the real error.
   */
  return error instanceof Error && error.name === "ApiError";
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
 * The name of the function the model calls to report what it recommended.
 */
export const RECOMMEND_PRODUCTS_FUNCTION = "recommend_products";

/**
 * The function the model calls to report the products it recommended.
 *
 * ── Why a function rather than a JSON schema ─────────────────────────────
 *
 * A JSON schema and a function call both give the ids a structured
 * channel, but they are not equivalent in what they cost.
 *
 * A schema constrains the **whole response**. The model is told to emit
 * a JSON object, so it writes a JSON object, and the customer's answer
 * has to fit inside a string field. That is precisely the "robot" feel
 * this refactor removes.
 *
 * A function call constrains **only the ids**. The prose is free, and
 * the ids come back as arguments — structured, machine-readable, and
 * completely separate from the words the customer reads.
 *
 * ── Why the ids are not simply asked for in the prose ────────────────────
 *
 * Because the ids are a *decision*, and this codebase's rule is that
 * decisions are made in code. An id recovered by parsing a paragraph is
 * an id that a paraphrase can corrupt, a bullet can bury, and a model
 * can simply forget. Here the id arrives as an argument to a call the
 * model chose to make, and it is validated against the allow-list
 * afterwards regardless.
 *
 * The description matters: Gemini decides whether to call the function
 * by reading it. So it says plainly that an empty list is a valid and
 * common answer — without that, a model told "recommend products" will
 * find something to recommend on a turn that called for nothing.
 */
const RECOMMEND_PRODUCTS_TOOL: Tool = {
  functionDeclarations: [
    {
      name: RECOMMEND_PRODUCTS_FUNCTION,
      description:
        "Report which products you recommended in your reply to the customer. Call this whenever your reply mentions a product, and call it with an empty list when your reply mentions none. The prose you write to the customer is the answer; this call only records the ids behind it.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          productIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              "The ids of the products you recommended. Every id must be one of the ids in the candidate list. Use an empty list when you recommended nothing.",
          },
        },
        required: ["productIds"],
      },
    },
  ],
};

/**
 * Options for the Gemini provider.
 */
export type GeminiProviderOptions = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * The SDK client to use.
   *
   * Injected by the tests so the request shape can be asserted without a
   * network call. Left unset in production, where the provider builds its
   * own client from the API key.
   */
  client?: GoogleGenAI;
};

/**
 * The real Gemini provider.
 */
export class GeminiProvider implements AiProvider {
  readonly name = GEMINI_PROVIDER_NAME;
  readonly modelName: string;

  /**
   * Gemini is multimodal, so this provider can look at the customer's
   * photograph.
   */
  readonly supportsVision = true;

  private readonly client: GoogleGenAI;
  private readonly timeoutMs: number;

  constructor(options: GeminiProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;

    if (!options.client) {
      if (!apiKey || apiKey.trim().length === 0) {
        throw new AiProviderError(
          GEMINI_PROVIDER_NAME,
          "AI_PROVIDER=gemini requires GEMINI_API_KEY to be set.",
        );
      }
    }

    this.client =
      options.client ?? new GoogleGenAI({ apiKey: apiKey?.trim() });
    this.modelName =
      options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Sends the request to Gemini and returns the parsed response.
   */
  async complete(request: AdvisorRequest): Promise<AdvisorResponse> {
    const payload = await this.sendWithRetry(request);

    /*
     * The prose and the ids can arrive in two different shapes.
     *
     * The happy path is a response with **both**: a text part carrying
     * the customer's answer, and a function-call part carrying the ids
     * behind it.
     *
     * But the model may also return a function call with no text at
     * all, or text with no function call. Both happen — the first
     * because a model in "tool mode" can answer with the call alone,
     * the second because a model may forget the call on a turn where it
     * had nothing to recommend.
     *
     * So both are read, and they are allowed to disagree. The marker
     * line in the prose is the fallback; the function call is the
     * primary. When both are present they are merged.
     */
    const text = payload.text?.trim();
    const calls = payload.functionCalls ?? [];

    if (!text && calls.length === 0) {
      /*
       * An empty response is usually a **safety block**, not a failure.
       *
       * Gemini returns no candidate when the prompt or the image trips a
       * safety filter. The advisor's whole domain is a photograph of
       * somebody's face, so a filter firing is a *normal* outcome rather
       * than an outage — and it deserves a message the customer can act
       * on, not a generic 500.
       */
      const blocked = payload.promptFeedback?.blockReason;

      if (blocked) {
        throw new AiProviderError(
          this.name,
          "The AI provider declined to answer this request.",
        );
      }

      throw new AiProviderError(
        this.name,
        "The AI provider returned an empty response.",
      );
    }

    const candidates = request.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
    }));

    /*
     * The marker line.
     *
     * It is parsed out of the prose and removed from it, so a customer
     * never sees `[RECOMMENDED: …]`. A reply with no marker is a
     * perfectly good reply — it just carries no ids.
     */
    const parsed = parseFreeTextReply(text ?? "", candidates);

    /*
     * The function call.
     *
     * The ids the model passed as arguments. An id that was never a
     * candidate cannot survive this: `parseFunctionCallIds` only
     * resolves ids and names that are actually on the candidate list.
     */
    const callIds: string[] = [];

    for (const call of calls) {
      if (call.name !== RECOMMEND_PRODUCTS_FUNCTION) continue;

      for (const id of parseFunctionCallIds(call.args, candidates)) {
        if (!callIds.includes(id)) callIds.push(id);
      }
    }

    /*
     * The two channels, merged.
     *
     * The function call comes first because it is the structured one.
     * The marker adds anything the call missed. Neither is trusted;
     * both are filtered against the allow-list below.
     */
    const productIds = [...callIds];

    for (const id of parsed.productIds) {
      if (!productIds.includes(id)) productIds.push(id);
    }

    const allowed = resolveAllowedIds(request);
    const recommendedProductIds = productIds.filter((id) =>
      allowed.has(id),
    );

    /*
     * The prose the customer sees.
     *
     * If the model returned only a function call, there is no prose to
     * show. That should not happen on a turn the model was given a
     * question for, but if it does, the turn is treated as a failure
     * rather than as an empty answer — an advisor that says nothing is
     * worse than an advisor that says something unhelpful.
     */
    const content = parsed.content.trim();

    if (content.length === 0) {
      throw new AiProviderError(
        this.name,
        "The AI provider returned a response without any content.",
      );
    }

    return {
      content,
      recommendedProductIds,
      providerName: this.name,
      modelName: this.modelName,
      isMocked: false,
    };
  }

  /**
   * Sends the request, retrying the failures that are worth retrying.
   *
   * ── Why the retry is here and not left to the SDK ───────────────────────
   *
   * Gemini returns `503 UNAVAILABLE` with *"this model is currently
   * experiencing high demand"* fairly often on the flash tier. That is
   * a **transient** failure: the same request, sent a second later,
   * usually succeeds. The SDK's own retry options do not cover every
   * path the request can take, and the live smoke test caught a `503`
   * that reached the customer as a hard error.
   *
   * So the retry lives here, where it can be reasoned about: it applies
   * to the errors that mean *"try again"*, it does not apply to the
   * errors that mean *"this will never work"* — a bad API key, a closed
   * model, a malformed request — and it is bounded so a bad day at
   * Google does not turn into a customer waiting forever.
   *
   * The delays are exponential with a cap, and the *total* time is
   * bounded by the same budget as the request timeout, so the chat
   * route's 30-second ceiling still holds.
   */
  private async sendWithRetry(
    request: AdvisorRequest,
  ): Promise<GenerateContentResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await this.delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.client.models.generateContent({
          model: this.modelName,
          contents: this.buildContents(request),
          config: {
            systemInstruction: this.buildSystemPrompt(request),
            temperature: 0.4,
            /*
             * No `responseMimeType`, no `responseJsonSchema`.
             *
             * The advisor used to ask for a strict JSON envelope, and
             * the result was an advisor that answered every turn in the
             * same shaped way — including dumping a routine on "hi".
             * With the constraint gone the model writes prose, and the
             * only structured thing it emits is the ids, through the
             * function call below.
             */
            tools: [RECOMMEND_PRODUCTS_TOOL],
            toolConfig: {
              functionCallingConfig: {
                /*
                 * AUTO, not ANY.
                 *
                 * ANY forces the model to call the function — which
                 * means a turn that recommends nothing still has to call
                 * it, and a live probe showed that mode produces the
                 * call *instead of* the prose rather than alongside it.
                 * AUTO lets the model speak first and call only when it
                 * has something to report.
                 */
                mode: FunctionCallingConfigMode.AUTO,
              },
            },
            abortSignal: controller.signal,
            httpOptions: { timeout: this.timeoutMs },
            /*
             * The photo is analysed at high resolution.
             *
             * The question being asked is "what is happening on this
             * person's skin" — texture, the edge of a blemish, the
             * difference between redness and a brown mark. A low
             * resolution thumbnail throws exactly those details away.
             */
            mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
          },
        });

        /*
         * The call-without-prose reply.
         *
         * A model in tool mode sometimes answers with the function call
         * and no text at all. That is the worst outcome the advisor can
         * produce — the customer gets nothing — and it is also
         * **transient**: it is a sampling accident, and the same model
         * writes the prose on the next attempt.
         *
         * The call's *presence* is what matters, not the ids it carried:
         * a greeting turn produces a call with an empty id list — the
         * model correctly saying "I recommended nothing" — and it is
         * still a reply the customer cannot read.
         */
        const hasProse = (response.text?.trim().length ?? 0) > 0;

        if (!hasProse && (response.functionCalls?.length ?? 0) > 0) {
          if (attempt < MAX_ATTEMPTS - 1) {
            console.warn(
              `[ai] Gemini answered with a function call and no prose (attempt ${attempt + 1}/${MAX_ATTEMPTS}). Retrying.`,
            );

            continue;
          }
        }

        return response;
      } catch (error) {
        lastError = error;

        // A timeout is not worth retrying — the route's own deadline
        // is about to be reached anyway.
        if (controller.signal.aborted) {
          throw this.toProviderError(error, true);
        }

        if (!isRetryable(error) || attempt === MAX_ATTEMPTS - 1) {
          throw this.toProviderError(error, false);
        }

        console.warn(
          `[ai] Gemini request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${describeError(error)}. Retrying.`,
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    // Unreachable: the loop either returns or throws. The throw is here
    // so the function is total for the type checker.
    throw this.toProviderError(lastError, false);
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
   * Builds the conversation contents.
   *
   * ── The shape of the conversation ──────────────────────────────────────
   *
   * The contents are a **real multi-turn conversation**, not one user
   * message with everything crammed into it:
   *
   * ```text
   * user       — the customer's first message
   * model      — the advisor's first answer
   * user       — the customer's second message
   * model      — the advisor's second answer
   * user       — the current message, with the brief and the photo
   * ```
   *
   * That is what makes the advisor feel like it is **remembering** the
   * customer. A model that sees only the latest message treats every
   * turn as a first meeting; a model that sees the transcript treats
   * "what about the retinol?" as a question about the retinol it
   * recommended two turns ago.
   *
   * ── Where the brief goes ───────────────────────────────────────────────
   *
   * The candidate list, the conflict list and the skin profile are
   * attached to the **current** user turn, not to the system
   * instruction. They describe *this* question — the candidates are
   * filtered for it and the conflicts are the ones relevant to it.
   *
   * The system instruction carries the **rules** that apply to every
   * turn; the brief carries the **facts** about this one.
   *
   * ── Why the history is truncated by the service, not here ──────────────
   *
   * The service layer caps how many turns it loads, because the history
   * is read from the database and an unbounded transcript would be an
   * unbounded prompt. The provider trusts the cap.
   */
  private buildContents(request: AdvisorRequest): Content[] {
    const contents: Content[] = [];

    /*
     * The prior turns.
     *
     * They are replayed as real conversation turns rather than pasted
     * into the brief, so the model treats them as something that
     * already happened rather than as context to summarise.
     *
     * A turn with no content is skipped — an assistant bubble that was
     * never filled in would otherwise appear as an empty message, and
     * an empty model turn teaches the model that it may answer with
     * nothing.
     */
    for (const turn of request.history ?? []) {
      const content = turn.content.trim();

      if (content.length === 0) continue;

      contents.push({
        role: turn.role === "ASSISTANT" ? "model" : "user",
        parts: [{ text: content }],
      });
    }

    /*
     * The current turn.
     *
     * The image, when there is one, rides with the current user turn —
     * which is where it belongs. The photo was attached to *this*
     * message, and the model needs to see it as part of the question it
     * is answering.
     */
    const parts: Part[] = [];

    if (request.image?.base64) {
      parts.push({
        inlineData: {
          mimeType: request.image.mimeType,
          data: request.image.base64,
        },
      });
    }

    parts.push({ text: this.buildUserBrief(request) });

    contents.push({ role: "user", parts });

    return contents;
  }

  /**
   * Builds the system instruction.
   *
   * The stored prompt carries the persona and the hard rules. Two things
   * are appended here rather than being baked into the stored prompt,
   * because they are facts about *this* request and the stored prompt
   * cannot know them:
   *
   *   • the **language rule** — the customer wrote in Bengali, in
   *     Banglish, or in English;
   *   • the **turn instruction** — the customer greeted, described a
   *     concern, or asked a question.
   *
   * Appending them also means an admin's prompt override still gets the
   * behaviour, which is the one thing the advisor must never lose: a
   * customer who writes in Bengali must be answered in Bengali, and a
   * customer who said "hi" must be greeted back rather than sold to.
   */
  private buildSystemPrompt(request: AdvisorRequest): string {
    const stored = request.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

    const languageRule = describeAdvisorLanguage(
      request.language ?? ENGLISH,
    );

    const turnRule = request.intent
      ? describeAdvisorIntent(request.intent)
      : null;

    return [stored, languageRule, turnRule].filter(Boolean).join("\n\n");
  }

  /**
   * Builds the user-facing brief.
   */
  private buildUserBrief(request: AdvisorRequest): string {
    const profileLines: string[] = [];

    if (request.profile.skinType) {
      profileLines.push(`- skin type: ${request.profile.skinType}`);
    }

    if (request.profile.concerns.length > 0) {
      profileLines.push(`- concerns: ${request.profile.concerns.join(", ")}`);
    }

    if (request.profile.notes) {
      profileLines.push(`- notes: ${request.profile.notes}`);
    }

    /*
     * The image note.
     *
     * When a photo is attached, the brief says so in plain words. The
     * prompt asks the model to analyse what it sees before
     * recommending, and a model that does not know a photo is attached
     * will not do that — it will simply answer the text.
     */
    const imageNote =
      request.image?.base64 === undefined
        ? []
        : [
            "",
            "PHOTO ATTACHED: The customer has attached a photo of their skin. Look at it before you answer. Acknowledge what you can see (for example texture, visible redness, dark spots, or blemishes), describe what it might suggest about their skin, and only then give your advice. Do not claim to have diagnosed anything — describe your observations as possibilities, not conclusions.",
          ];

    /*
     * The turn's intent, restated in the brief.
     *
     * The system instruction carries it too, but the brief is the
     * part of the prompt that describes *this* turn specifically, and a
     * model reading the two together has no room to misread the turn.
     */
    const intentNote = request.intent
      ? [
          "",
          "THIS TURN:",
          `- kind: ${request.intent.kind}`,
          `- recommendations allowed on this turn: ${request.intent.mayRecommend ? "yes" : "no"}`,
          `- ingredient-conflict warnings allowed on this turn: ${request.intent.mayWarn ? "yes" : "no"}`,
          request.intent.missing.length > 0
            ? `- still unknown: ${request.intent.missing.join(", ")}`
            : "- still unknown: nothing — the skin profile already covers it",
        ]
      : [];

    /*
     * The conflict section.
     *
     * The header says "do not contradict, downgrade or omit" — which is
     * an instruction to *handle* the conflicts. On a turn that may not
     * warn, the list is empty and that instruction would be nonsense:
     * it would read to the model as "there were no conflicts, so do not
     * mention any", when the truth is "there may well be conflicts, but
     * this turn is not about the routine".
     *
     * So the two cases get different headers, and the suppressed case
     * says plainly that the subject is off the table for this turn.
     */
    const conflictSection =
      request.intent && !request.intent.mayWarn
        ? [
            "CONFLICTS:",
            "(not relevant to this turn — do not mention ingredient conflicts, what the customer already owns, or anything about combining products)",
          ]
        : [
            "CONFLICTS (decided by code — do not contradict, downgrade or omit):",
            describeConflicts(request.conflicts),
          ];

    return [
      "CUSTOMER QUESTION:",
      request.userMessage,
      ...imageNote,
      ...intentNote,
      "",
      "SKIN PROFILE:",
      profileLines.length > 0 ? profileLines.join("\n") : "(none provided)",
      "",
      "CANDIDATES:",
      describeCandidates(request.candidates),
      "",
      ...conflictSection,
      "",
      "IMPORTANT: This is an aesthetic/skincare suggestion, not a medical prescription from a doctor. Do not diagnose any condition. If the customer describes a persistent or severe concern, advise them to see a dermatologist.",
      "",
      "HOW TO REPORT YOUR RECOMMENDATIONS:",
      "Write your reply to the customer as plain prose — that is what they read. Then, on the very last line, output exactly one line listing the products you recommended in that prose:",
      "[RECOMMENDED: id1, id2]",
      "If you recommended nothing, output exactly:",
      "[RECOMMENDED: none]",
      "Use the ids from the candidate list above. Write nothing after that line, and never mention the line itself to the customer.",
    ].join("\n");
  }

  /**
   * Converts an SDK failure into an `AiProviderError`.
   *
   * The SDK's own error messages can carry the API key in a request
   * dump, so the raw error is attached as the `cause` — which is logged
   * server-side — and never returned to the customer.
   *
   * ── The status code decides the message ─────────────────────────────────
   *
   * Three failures look identical from the outside and mean very
   * different things:
   *
   *   • `404` — the model is closed to this account. Retrying will never
   *     help; the deployment is pointed at a model that does not exist
   *     for it.
   *   • `401`/`403` — the API key is wrong or lacks access.
   *   • `429`/`503` — transient. These are retried above, and the
   *     message reaching the customer is only seen when the retries
   *     were exhausted.
   */
  private toProviderError(error: unknown, aborted: boolean): AiProviderError {
    if (error instanceof AiProviderError) {
      return error;
    }

    if (aborted) {
      return new AiProviderError(
        this.name,
        `The AI provider did not respond within ${this.timeoutMs}ms.`,
        error,
      );
    }

    const status = statusOf(error);
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `[ai] Gemini request failed${status === null ? "" : ` (status ${status})`}: ${message.slice(0, 500)}`,
    );

    if (status === 404) {
      return new AiProviderError(
        this.name,
        `The AI model "${this.modelName}" is not available to this account. Check the GEMINI_MODEL setting.`,
        error,
      );
    }

    if (status === 401 || status === 403) {
      return new AiProviderError(
        this.name,
        "The AI provider rejected the API key.",
        error,
      );
    }

    if (status === 429) {
      return new AiProviderError(
        this.name,
        "The AI provider is rate limiting this account. Please try again shortly.",
        error,
      );
    }

    return new AiProviderError(
      this.name,
      "Could not reach the AI provider.",
      error,
    );
  }
}
