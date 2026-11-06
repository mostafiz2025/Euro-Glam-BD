import {
  DEFAULT_SYSTEM_PROMPT,
  describeCandidates,
  describeConflicts,
  resolveAllowedIds,
  type AdvisorRequest,
  type AdvisorResponse,
} from "./provider";

import { ENGLISH, describeAdvisorLanguage } from "./language";
import { describeAdvisorIntent } from "./intent";
import {
  parseFreeTextReply,
  parseFunctionCallIds,
  parseNamedProductIds,
  type MarkerCandidate,
} from "./free-text";

/**
 * The OpenAI-compatible chat-completions protocol.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * OpenRouter speaks the **OpenAI chat-completions dialect**. The request
 * shape, the message roles, the image format and the reply shape are the
 * same ones OpenAI uses — the differences are the URL, the headers and
 * the routing preferences.
 *
 * So the protocol is written **once**, here, and the two providers differ
 * only in how they address the endpoint and what they put on the wire
 * around the same body. A second copy of the prompt assembly would be a
 * second copy of the advisor's *behaviour*, and the two copies would
 * drift: the day the language rule or the marker convention changed in
 * one, the other would still be sending the old prompt, and the
 * difference would show up as a model that suddenly stopped
 * recommending products.
 *
 * ── What stays out of this file ───────────────────────────────────────────
 *
 * The **provider-specific** concerns:
 *
 *   • the endpoint URL;
 *   • the authentication and identification headers;
 *   • the routing preferences (OpenRouter's provider fallbacks);
 *   • the retry policy.
 *
 * Those belong to the providers, and each has its own answer to them.
 */

/**
 * A message in the chat-completions request.
 */
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

/**
 * The shape of the API response we care about.
 *
 * Both providers read the same fields, because both speak the same
 * dialect. `error` is read as well as the HTTP status, because a
 * gateway can report a failure inside a `200` body — and OpenRouter in
 * particular can attach a per-choice `error` when an upstream provider
 * fails mid-stream.
 */
export type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      /**
       * The structured calls the model made.
       *
       * The arguments arrive as a JSON **string** — that is the dialect,
       * not an oversight — so they are parsed here rather than being
       * handed around as strings.
       */
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
    error?: { message?: string; code?: number | string; type?: string };
  }>;
  error?: { message?: string; type?: string; code?: string | number };
  /** The model that actually served the request. */
  model?: string;
};

/**
 * The body of the chat-completions request.
 *
 * The `provider` key is OpenRouter's routing preferences and is **not**
 * part of OpenAI's dialect. It is left out of this type and added by the
 * OpenRouter provider itself, so the OpenAI provider never sends a field
 * OpenAI would reject.
 */
export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
};

/**
 * The ceiling on the reply's length, in tokens.
 *
 * ── Why the request must state one ───────────────────────────────────────
 *
 * A chat-completions request may leave the reply length to the model, and
 * the model may then use as much as its context window allows. On
 * OpenRouter that has a **cost**, because the provider reserves credit
 * against the model's *maximum* context window before it runs the
 * request — not against the tokens the reply will actually use.
 *
 * A live call with no `max_tokens` was refused outright:
 *
 * > This request requires more credits, or fewer max_tokens. You requested
 * > up to 131072 tokens, but can only afford 34923.
 *
 * The advisor's reply is a few hundred tokens. The reservation was for
 * the whole context, and the request was refused for it. So the request
 * states its own ceiling, and the ceiling is set from measured usage
 * rather than from a guess.
 *
 * ── How the number was chosen ────────────────────────────────────────────
 *
 * Measured against the real API, on the real prompt, in the language the
 * shop actually serves:
 *
 * | turn                | prompt tokens | completion tokens |
 * |---------------------|---------------|-------------------|
 * | greeting            |          1607 |                 99 |
 * | concern (Bengali)   |          1633 |                534 |
 * | question (English)  |          1624 |                536 |
 * | long question       |          1686 |                676 |
 *
 * Bengali is token-heavy, and the completion figure grows with the
 * question, so the ceiling is set well above the longest observed reply
 * while staying far below the model's context window. A reply that hits
 * the ceiling is truncated rather than refused — which is a far better
 * outcome than a request that never runs at all.
 */
export const MAX_COMPLETION_TOKENS = 1200;

/**
 * The default request timeout in milliseconds.
 *
 * A provider call sits in front of a user waiting for a reply. The chat
 * route sets `maxDuration = 30`; the timeout here is deliberately shorter
 * so the route can return a clean 502 rather than being killed by the
 * platform timeout with no error message.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The temperature the advisor runs at.
 *
 * Low enough that the advice is consistent, high enough that the reply
 * does not read like a form letter — which is the whole point of the
 * free-prose refactor.
 */
export const ADVISOR_TEMPERATURE = 0.4;

/**
 * The name of the function the model calls to report what it recommended.
 *
 * The same name Gemini uses, deliberately: the two providers are two
 * ways of saying the same thing to a model, and one name means one
 * convention to learn rather than two.
 */
export const RECOMMEND_PRODUCTS_FUNCTION = "recommend_products";

/**
 * The tool the model calls to report the products it recommended.
 *
 * ── Why a tool call, and not only the marker line ────────────────────────
 *
 * The advisor has to get the product ids back from the model, and the
 * only channel it had was a convention in the prose: the model appends
 * a `[RECOMMENDED: …]` line, and the provider strips it.
 *
 * A convention is a **request**, and a request is only as reliable as
 * the model's mood. Measured against the live API on the conversation
 * turn — the turn where the customer has described their skin and a
 * recommendation is genuinely called for — the marker was **dropped in
 * roughly a third of runs**. When it was dropped, `recommendedProductIds`
 * came back empty and the shop attached **no product cards at all**: the
 * advice was still good, but the products were invisible.
 *
 * A tool call is the same information delivered structurally, and a
 * model that has been *asked* to call a tool is far more consistent about
 * it than a model that has been asked to remember a line format.
 *
 * ── Why the description says the empty list is a valid answer ───────────
 *
 * Because a model told "recommend products" will find something to
 * recommend on a turn that called for nothing. Saying plainly that an
 * empty list is common and correct is what stops the advisor from
 * inventing a routine on a greeting.
 *
 * ── Why the tool does not replace the marker ─────────────────────────────
 *
 * Because it cannot be relied on alone either. Measured over the same
 * runs, the tool call fired in **about a quarter** of them — the model
 * often answers with prose and the marker instead. So the two channels
 * are kept, and both are read. See `toAdvisorResponse`.
 */
export const RECOMMEND_PRODUCTS_TOOL = {
  type: "function",
  function: {
    name: RECOMMEND_PRODUCTS_FUNCTION,
    description:
      "Report which products you recommended in your reply to the customer. Call this whenever your reply mentions a product, and call it with an empty list when your reply mentions none. The prose you write to the customer is the answer; this call only records the ids behind it.",
    parameters: {
      type: "object",
      properties: {
        productIds: {
          type: "array",
          items: { type: "string" },
          description:
            "The ids of the products you recommended. Every id must be one of the ids in the candidate list. Use an empty list when you recommended nothing.",
        },
      },
      required: ["productIds"],
    },
  },
} as const;

/**
 * The rule that tells the model to write the prose **and** make the call.
 *
 * ── Why this rule exists at all ──────────────────────────────────────────
 *
 * A model given a tool sometimes answers with the **call alone** and no
 * prose whatsoever — `content` empty, one tool call, nothing for the
 * customer to read. That was observed directly on the live API:
 *
 * ```json
 * { "content": null, "tool_calls": [{ "function": { "name": "recommend_products" } }] }
 * ```
 *
 * Left alone, that is a worse failure than a missing product card: the
 * customer gets **no reply at all**.
 *
 * So the request says, in as many words, that the prose is the answer
 * and the call is only the bookkeeping. With the rule in place, prose
 * came back on **every** measured run, and the ids came back on most of
 * them.
 *
 * The rule is appended to the system prompt rather than baked into the
 * stored prompt, for the same reason the language rule and the turn
 * instruction are: an admin's prompt override must not be able to lose
 * the behaviour.
 */
export const PROSE_AND_TOOL_RULE = [
  "",
  "HOW TO ANSWER THIS TURN:",
  "Do BOTH of these, every time:",
  "1. Write your reply to the customer as plain prose in your answer text — that is what they read.",
  "2. Call the recommend_products tool with the ids of the products you recommended in that prose (an empty list when you recommended none).",
  "Never skip the prose. The tool call only records ids; it is not the reply.",
].join("\n");

/**
 * Builds the chat messages.
 *
 * ── The shape of the conversation ──────────────────────────────────────
 *
 * The messages are a **real multi-turn conversation**, not one user
 * message with everything crammed into it:
 *
 * ```text
 * system     — the persona, the hard rules, and the language rule
 * user       — the customer's first message
 * assistant  — the advisor's first answer
 * user       — the customer's second message
 * assistant  — the advisor's second answer
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
 * attached to the **current** user turn, not to the system prompt.
 *
 * Two reasons. First, they describe *this* question — the
 * candidates are filtered for it and the conflicts are the ones
 * relevant to it. Second, and more importantly, the request has to
 * end with a user message, and the product ids need to be attached to
 * the message that asks for them.
 *
 * The system prompt carries the **rules** that apply to every turn;
 * the brief carries the **facts** about this one.
 *
 * ── Why the history is truncated by the service, not here ──────────────
 *
 * The service layer caps how many turns it loads, because the history
 * is read from the database and an unbounded transcript would be an
 * unbounded prompt. The provider trusts the cap.
 */
export function buildChatMessages(
  request: AdvisorRequest,
): ChatMessage[] {
  const systemPrompt = request.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(systemPrompt, request) },
  ];

  /*
   * The prior turns.
   *
   * They are replayed as real conversation turns rather than pasted
   * into the brief, so the model treats them as something that
   * already happened rather than as context to summarise.
   *
   * A turn with no content is skipped — an assistant bubble that was
   * never filled in would otherwise appear as an empty message, and
   * an empty assistant turn teaches the model that it may answer
   * with nothing.
   */
  for (const turn of request.history ?? []) {
    const content = turn.content.trim();

    if (content.length === 0) continue;

    messages.push({
      role: turn.role === "ASSISTANT" ? "assistant" : "user",
      content,
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
  const userContent: Array<Record<string, unknown>> = [
    { type: "text", text: buildUserBrief(request) },
  ];

  if (request.image?.base64) {
    userContent.unshift({
      type: "image_url",
      image_url: {
        url: `data:${request.image.mimeType};base64,${request.image.base64}`,
        /*
         * The detail level is `auto`, not `low`.
         *
         * `low` sends a fixed, cheap thumbnail — which is fine for
         * "what is in this picture", and useless for the question
         * actually being asked here: what is happening on this
         * person's skin. Texture, the edge of a blemish and the
         * difference between redness and a brown mark are all
         * details a low-resolution thumbnail throws away.
         *
         * `auto` lets the model pick the resolution from the image's
         * own dimensions, so a small photo is not upsampled into a
         * large one and a large one is not truncated.
         */
        detail: "auto",
      },
    });
  }

  messages.push({ role: "user", content: userContent });

  return messages;
}

/**
 * Builds the system prompt.
 *
 * The stored prompt carries the persona and the hard rules. Three things
 * are appended here rather than being baked into the stored prompt,
 * because they are facts about *this* request and the stored prompt
 * cannot know them:
 *
 *   • the **language rule** — the customer wrote in Bengali, in
 *     Banglish, or in English;
 *   • the **turn instruction** — the customer greeted, described a
 *     concern, or asked a question;
 *   • the **answering rule** — write the prose, and make the tool call.
 *
 * Appending them also means an admin's prompt override still gets the
 * behaviour, which is the one thing the advisor must never lose: a
 * customer who writes in Bengali must be answered in Bengali, and a
 * customer who said "hi" must be greeted back rather than sold to.
 */
export function buildSystemPrompt(
  systemPrompt: string,
  request: AdvisorRequest,
): string {
  const languageRule = describeAdvisorLanguage(
    request.language ?? ENGLISH,
  );

  const turnRule = request.intent
    ? describeAdvisorIntent(request.intent)
    : null;

  return [
    systemPrompt,
    languageRule,
    turnRule,
    PROSE_AND_TOOL_RULE,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Builds the user-facing brief.
 */
export function buildUserBrief(request: AdvisorRequest): string {
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
   * The header says "do not contradict, downgrade or omit" — which is an
   * instruction to *handle* the conflicts. On a turn that may not warn,
   * the list is empty and that instruction would be nonsense: it would
   * read to the model as "there were no conflicts, so do not mention
   * any", when the truth is "there may well be conflicts, but this turn
   * is not about the routine".
   *
   * So the two cases get different headers, and the suppressed case says
   * plainly that the subject is off the table for this turn.
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
 * The outcome of reading a chat-completions response.
 *
 * A failure is returned rather than thrown, because the error a provider
 * raises is an `AiProviderError` — and the two providers raise it with
 * their own names. The reader does not know which provider is calling
 * it, so it reports *what* went wrong and lets the provider wrap it.
 *
 * The `functionCallIds` are carried on **both** branches, because they
 * are the one thing a failed read still knows: when the model answered
 * with a tool call and no prose, the ids are known even though the
 * reply is not usable.
 */
export type ChatCompletionRead =
  | {
      readonly ok: true;
      readonly content: string;
      readonly functionCallIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly functionCallIds: readonly string[];
      /**
       * Whether trying again could plausibly produce a different answer.
       *
       * A model that answered with a tool call and no prose is a
       * **behaviour**, not a fault — the same model will write the prose
       * on the next attempt, and it is worth one more try because the
       * alternative is a customer who gets no reply.
       */
      readonly retryable: boolean;
    };

/**
 * Reads the model's reply out of a chat-completions response.
 *
 * ── The failure modes, and what each one means ─────────────────────────
 *
 *   • **No choices at all** — the request was rejected or the gateway
 *     returned nothing usable.
 *   • **A choice with an `error`** — OpenRouter reports an upstream
 *     provider failure *inside* a `200` response, alongside the other
 *     choices. That failure has to be surfaced as a provider error, not
 *     silently turned into an empty answer.
 *   • **An empty `content`** — the model chose to say nothing. The
 *     advisor that answers nothing is worse than one that answers
 *     badly, so it is an error rather than an empty reply.
 *
 * ── The tool-call-only case ──────────────────────────────────────────────
 *
 * A response can carry a tool call and **no prose at all**:
 *
 * ```json
 * { "content": null, "tool_calls": [{ "function": { "name": "recommend_products" } }] }
 * ```
 *
 * That was observed directly on the live API. It is reported as a
 * failure — the customer has no reply — but it is marked **retryable**,
 * because the same model writes the prose on a second attempt, and one
 * more try is a far better outcome than an empty answer.
 *
 * The retryable case is detected by the **presence of the call**, not by
 * the ids it carried. A greeting turn produces a call with an *empty*
 * id list — the model correctly saying "I recommended nothing" — and
 * that is still a call with no prose beside it, so it is still a reply
 * the customer cannot read.
 *
 * @param payload - The parsed response body.
 * @param candidates - The products the model was allowed to name.
 */
export function readChatCompletionContent(
  payload: ChatCompletionResponse,
  candidates: readonly MarkerCandidate[] = [],
): ChatCompletionRead {
  const topLevelError = payload.error;

  if (topLevelError) {
    return {
      ok: false,
      message: `The AI provider returned an error: ${topLevelError.message ?? "unknown"}`,
      functionCallIds: [],
      retryable: false,
    };
  }

  const choice = payload.choices?.[0];

  if (choice?.error) {
    return {
      ok: false,
      message: `The AI provider returned an error: ${choice.error.message ?? "unknown"}`,
      functionCallIds: [],
      retryable: false,
    };
  }

  const functionCallIds = readFunctionCallIds(choice?.message?.tool_calls, candidates);

  if (!choice?.message?.content) {
    /*
     * The tool-call-only reply.
     *
     * The presence of the call is what matters, not the ids it carried:
     * a greeting turn produces a call with an **empty** id list — the
     * model correctly reporting that it recommended nothing — and it is
     * still a reply the customer cannot read.
     */
    const toolCallOnly = hasRecommendProductsCall(choice?.message?.tool_calls);

    return {
      ok: false,
      message: toolCallOnly
        ? "The AI provider answered with a tool call but no reply text."
        : "The AI provider returned an empty response.",
      functionCallIds,
      retryable: toolCallOnly,
    };
  }

  return { ok: true, content: choice.message.content, functionCallIds };
}

/**
 * Whether the model called the recommendation function at all.
 *
 * ── Why the call's presence, and not its ids ──────────────────────────────
 *
 * A call with an **empty** id list is still a call. It is the model
 * saying "I recommended nothing" — which is the right thing to say on a
 * greeting — but it is said *instead of* the prose, and a customer
 * cannot read a tool call.
 *
 * So the question this answers is "did the model answer with a call
 * rather than with words?", and the answer is what makes the turn
 * retryable.
 *
 * @param calls - The tool calls from the response.
 */
export function hasRecommendProductsCall(
  calls:
    | Array<{ function?: { name?: string; arguments?: string } }>
    | undefined,
): boolean {
  return (calls ?? []).some(
    (call) => call.function?.name === RECOMMEND_PRODUCTS_FUNCTION,
  );
}

/**
 * Reads the ids out of the model's tool calls.
 *
 * ── Why the arguments are parsed here ────────────────────────────────────
 *
 * In the OpenAI chat-completions dialect a tool call's arguments are a
 * **JSON string**, not an object. The dialect is the same one Gemini
 * uses with one difference: Gemini hands over an already-decoded
 * object. So the string is decoded here, and the result is handed to the
 * shared reader in `free-text.ts` — which means the two providers agree
 * on what a valid argument list looks like.
 *
 * A malformed argument string is **not** an error. The model wrote
 * something the provider cannot read, and there is still the marker line
 * and the prose to fall back on.
 *
 * @param calls - The tool calls from the response.
 * @param candidates - The products the model was allowed to name.
 */
export function readFunctionCallIds(
  calls:
    | Array<{ function?: { name?: string; arguments?: string } }>
    | undefined,
  candidates: readonly MarkerCandidate[] = [],
): string[] {
  const ids: string[] = [];

  for (const call of calls ?? []) {
    if (call.function?.name !== RECOMMEND_PRODUCTS_FUNCTION) continue;

    const raw = call.function?.arguments;

    if (typeof raw !== "string" || raw.trim().length === 0) continue;

    let args: unknown;

    try {
      args = JSON.parse(raw) as unknown;
    } catch {
      // A malformed argument string is not worth failing the turn over.
      continue;
    }

    for (const id of parseFunctionCallIds(args, candidates)) {
      if (!ids.includes(id)) ids.push(id);
    }
  }

  return ids;
}

/**
 * Turns a model's reply into an advisor response.
 *
 * ── The three channels ───────────────────────────────────────────────────
 *
 * The ids come back on whichever of three channels carries them, and the
 * channels are consulted in order of **how much the model had to
 * cooperate**:
 *
 *   1. **The tool call.** The model was given a function and asked to
 *      call it; the ids are its structured arguments.
 *   2. **The marker line.** The model was asked to end its reply with
 *      `[RECOMMENDED: …]`.
 *   3. **The names in the prose.** The model *mentioned* the products
 *      it put in front of the customer, and their names are in the
 *      candidate list.
 *
 * The first two are **statements** — "I recommended these". The third is
 * an **observation** — "this product was mentioned" — and a model can
 * mention a product without recommending it. So the third channel is
 * consulted **only** when the first two have both come back empty, and
 * it skips the conflicted products, because naming a conflicted product
 * is how the model *warns* about it.
 *
 * Measured against the live API on the conversation turn, where the
 * marker was dropped in roughly a third of runs:
 *
 * | channel | recovered |
 * |---------|-----------|
 * | the marker line   |  6 / 8 runs |
 * | the tool call     |  0 / 8 runs |
 * | the names         |  8 / 8 runs |
 *
 * ── The response is still untrusted ────────────────────────────────────
 *
 * The model can return an id that was never a candidate, or a severity
 * it invented. The service layer validates ids against the allow-list
 * and re-attaches the code-decided conflicts after this returns. The
 * model cannot widen its own permissions.
 *
 * @param content - The model's prose.
 * @param request - The request the reply answers.
 * @param providerName - The provider's name, as recorded on the message.
 * @param modelName - The model that wrote the reply.
 * @param functionCallIds - The ids the model's tool call carried.
 */
export function toAdvisorResponse(
  content: string,
  request: AdvisorRequest,
  providerName: string,
  modelName: string,
  functionCallIds: readonly string[] = [],
): AdvisorResponse {
  const candidates = request.candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
  }));

  const parsed = parseFreeTextReply(content, candidates);

  /*
   * The two stated channels, merged.
   *
   * The tool call comes first because it is the structured one. The
   * marker adds anything the call missed. Neither is trusted; both are
   * filtered against the allow-list below.
   */
  const productIds = [...functionCallIds];

  for (const id of parsed.productIds) {
    if (!productIds.includes(id)) productIds.push(id);
  }

  /*
   * The fallback: the names in the prose.
   *
   * Consulted **only** when neither stated channel found anything, and
   * only when the marker was **absent altogether**.
   *
   * That last condition is the important one. A marker that says
   * `[RECOMMENDED: none]` is a **statement** — the model saying "I
   * recommended nothing" — and a statement is not the same thing as a
   * marker that was never written. Falling through to the names after an
   * explicit "none" would put a product card in front of a customer the
   * model had just told to buy nothing.
   *
   * The conflicted products are also excluded: a conflicted product is
   * one the model has been asked to warn about, so naming it is the
   * warning and not a recommendation.
   */
  if (productIds.length === 0 && !parsed.hadMarker) {
    const mayRecommend = request.intent?.mayRecommend ?? true;

    if (mayRecommend) {
      const conflictedIds = request.conflicts.flatMap((conflict) =>
        conflict.involvedProductIds,
      );

      for (const id of parseNamedProductIds(
        parsed.content,
        candidates,
        conflictedIds,
      )) {
        if (!productIds.includes(id)) productIds.push(id);
      }
    }
  }

  // The model can still name an id it was never given. The service layer
  // drops those, but filtering here as well keeps the recorded response
  // honest and avoids persisting an invalid id.
  const allowed = resolveAllowedIds(request);
  const recommendedProductIds = productIds.filter((id) => allowed.has(id));

  return {
    content: parsed.content,
    recommendedProductIds,
    providerName,
    modelName,
    isMocked: false,
  };
}
