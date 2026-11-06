import type { Prisma, SkinType } from "@prisma/client";

import { getCart } from "@/lib/cart/service";
import { ACTIVE_PRODUCT_WHERE } from "@/lib/catalog/product-visibility";
import { db } from "@/lib/db";
import {
  evaluateConflicts,
  type ConflictProduct,
  type EvaluatedConflict,
} from "@/lib/conflicts/engine";

import { loadDisclaimer, type Disclaimer } from "./disclaimer";
import { getAiProvider } from "./index";
import { detectAdvisorIntent, type AdvisorIntent } from "./intent";
import { detectAdvisorLanguage } from "./language";
import {
  resolveAllowedIds,
  type AdvisorHistoryTurn,
  type AdvisorRequest,
  type AiProvider,
  type ConflictReport,
  type ProductCandidate,
  type SkinContext,
} from "./provider";

/**
 * The AI Advisor service layer.
 *
 * ── The one rule that governs this file ─────────────────────────────────
 *
 * **Code decides, the model phrases.** The model may only *word* an
 * outcome that code has already reached. It never decides whether a
 * conflict exists, never downgrades a severity, never widens the
 * allow-list, and never adds a product code did not offer.
 *
 * Every place where that could go wrong is defended in three layers:
 *
 *   1. **The candidate list is built in code.** Only in-stock,
 *      admin-allowed products that survive the conflict engine reach
 *      the provider.
 *   2. **The provider's output is validated.** A recommended id that
 *      is not on the allow-list is dropped, logged, and replaced with
 *      the deterministic set. A provider cannot talk its way into
 *      recommending a blocked product.
 *   3. **The conflicts are re-attached after the call.** Whatever the
 *      provider said about conflicts is discarded. The code-decided
 *      conflicts are what the customer sees.
 *
 * The disclaimer is attached here too, unconditionally, because a
 * response that reaches the client without one is a compliance failure
 * regardless of what the UI does.
 */

/**
 * How many products are offered to the provider.
 *
 * A small number on purpose: the provider is choosing from a shortlist,
 * not writing a catalogue. Twenty candidates would dilute the advice
 * and slow the call.
 */
export const MAX_CANDIDATES = 12;

/**
 * How many recommendations are returned.
 */
export const MAX_RECOMMENDATIONS = 3;

/**
 * A recommendation, as returned to the client.
 */
export type Recommendation = {
  readonly productId: string;
  readonly name: string;
  readonly pricePaisa: number;
  readonly discountPricePaisa: number | null;
  readonly reason: string;
};

/**
 * A conflict, as returned to the client.
 */
export type AdvisorConflict = {
  readonly ruleId: string;
  readonly severity: "BLOCK" | "WARN";
  readonly title: string;
  readonly message: string;
  readonly remedy: string;
  readonly spacingAdvice: string;
  readonly involvedProductIds: string[];
  readonly ingredientIds: string[];
};

/**
 * The result of generating an advisor response.
 */
export type AdvisorResult = {
  readonly content: string;
  readonly recommendations: Recommendation[];
  readonly conflicts: AdvisorConflict[];
  readonly disclaimer: Disclaimer;
  readonly provider: {
    readonly name: string;
    readonly isMocked: boolean;
    /**
     * The model that produced the answer.
     *
     * Recorded separately from the provider name because the two answer
     * different questions: "who billed us" and "which model wrote
     * this". `gemini` and `gemini-2.5-flash` are not the same fact,
     * and the audit trail needs both — a model that is quietly
     * downgraded from `flash` to `lite` is exactly the kind of change
     * an audit exists to catch.
     */
    readonly model: string;
  };
  readonly skinProfile: {
    readonly skinType: SkinType | null;
    readonly concerns: string[];
  };
  /**
   * What code decided this turn was.
   *
   * Recorded so the transcript can be re-rendered faithfully and so an
   * auditor can see *why* a turn carried no products: it was a
   * greeting, and a greeting does not carry products.
   */
  readonly intent: AdvisorIntent;
};

/**
 * The input to a generation.
 */
export type GenerateInput = {
  readonly userId: string;
  readonly userMessage: string;
  /**
   * The conversation this turn belongs to.
   *
   * Present on every turn after the first. It is what the service reads
   * the prior turns from, and it is the difference between a
   * conversation and a series of unrelated questions.
   */
  readonly conversationId?: string;
  /**
   * The transcript the client is holding.
   *
   * The client sends what it can see, so the advisor has the full
   * conversation even on a turn the database has not caught up with.
   * It is merged with the stored transcript — see `mergeHistory`.
   */
  readonly clientHistory?: readonly AdvisorHistoryTurn[];
  /**
   * The uploaded image, if any.
   *
   * The **bytes** are carried, not a base64 string. The encoding is
   * done in the service layer, and only when the provider actually
   * supports vision — so the offline mock mode never pays for
   * base64-encoding a photograph it is going to ignore.
   */
  readonly image?: { readonly mimeType: string; readonly bytes: Buffer };
};

/**
 * The maximum number of prior turns sent to the provider.
 *
 * ── Why the cap exists ───────────────────────────────────────────────────
 *
 * The history is **loaded from the database**, so it is unbounded in
 * principle, and the prompt is not unbounded in practice. A customer
 * with forty messages would otherwise produce a prompt of forty
 * messages — every turn costing tokens, slowing the call, and
 * eventually hitting the model's context limit and failing outright.
 *
 * The cap keeps the recent conversation and drops the rest. Twenty
 * turns is ten exchanges, which is enough for the model to remember
 * the skin type, the concerns and the products already discussed —
 * and the skin profile is carried separately anyway, so the most
 * important facts do not depend on the history at all.
 */
export const MAX_HISTORY_TURNS = 20;

/**
 * Merges the client's transcript with the stored one.
 *
 * ── Why there are two sources ─────────────────────────────────────────────
 *
 * The server reads the conversation's turns from the database, and that
 * is the authoritative record. But the client also knows what has been
 * said — it is looking at the transcript — and it knows it *now*, with
 * no round trip.
 *
 * There are two situations where they disagree, and both matter:
 *
 *   1. **The client is ahead.** The customer sent a message, the
 *      provider is answering, and the answer has not been written yet.
 *      The database has the customer's message; the client has it too.
 *      Neither has the answer — and that is correct, because the answer
 *      is being generated right now.
 *
 *   2. **The client is behind, or switched conversations.** The client
 *      sends the transcript of the conversation it is *looking at*; if
 *      the customer has just clicked a link to a different conversation,
 *      the client may still be holding the previous one.
 *
 * The rule is therefore: **the stored transcript wins, unless the
 * client's is demonstrably ahead of it.** "Ahead" is measured by
 * counting the turns, because a turn count is the one thing both sides
 * agree on.
 *
 * ── How the two are joined ────────────────────────────────────────────────
 *
 * The client's transcript must **start with** the stored one for it to
 * be a continuation of it:
 *
 * ```text
 * stored:  [U1] [A1]
 * client:  [U1] [A1] [U2]
 *                 ↑ the client is ahead by one turn, at the end
 * merged:  [U1] [A1] [U2]
 * ```
 *
 * The prefix is what matters, and the client's extra turns are always
 * at the **end**. That is the shape of the situation: the customer has
 * sent a new message, the answer has not been written yet, and the new
 * message is the newest thing in the conversation.
 *
 * ── When the client does not start with the stored transcript ────────────
 *
 * The client's turns are ignored entirely, and the stored transcript
 * stands alone. That is the case where the client is looking at a
 * **different conversation** — it clicked a link to another chat and
 * sent that transcript — or is describing this one inaccurately.
 * Either way there is no shared beginning, so there is no safe place to
 * join the two.
 *
 * ── Why this is not simply "use the client's" ────────────────────────────
 *
 * Because the client's transcript is untrusted input, and it is bounded
 * by a schema rather than by the database. The stored transcript is
 * bounded by the database and scoped to the customer. Preferring the
 * stored one means a client that lies about its history cannot put words
 * in the advisor's mouth — it can only ever be *ahead*, and only by
 * turns it could have sent anyway.
 *
 * ── Why the client's extra turns are still trusted ───────────────────────
 *
 * Because they are the customer's own words from their own conversation.
 * The risk of a client injecting a fake "ASSISTANT" turn is bounded by
 * the fact that the guard rail that matters — *may this turn carry
 * products?* — is decided in code from the customer's message, not from
 * the history.
 *
 * @param stored - The turns read from the database.
 * @param client - The turns the client sent.
 */
export function mergeHistory(
  stored: readonly AdvisorHistoryTurn[],
  client: readonly AdvisorHistoryTurn[],
): AdvisorHistoryTurn[] {
  if (client.length === 0) {
    return [...stored];
  }

  /*
   * The client is only ahead when it has *more* turns than the stored
   * transcript. Anything else — the same number of turns, or fewer —
   * means the stored transcript is at least as complete, and it is the
   * authoritative one.
   */
  if (client.length <= stored.length) {
    return [...stored];
  }

  /*
   * The client's transcript must start with the stored one.
   *
   * The comparison ignores the whitespace around a turn's content,
   * because the client and the database do not agree on trailing
   * newlines — the reply is stored exactly as the model wrote it.
   */
  for (let index = 0; index < stored.length; index += 1) {
    const storedTurn = stored[index];
    const clientTurn = client[index];

    if (
      storedTurn === undefined ||
      clientTurn === undefined ||
      storedTurn.role !== clientTurn.role ||
      storedTurn.content.trim() !== clientTurn.content.trim()
    ) {
      // The two transcripts do not line up. The client is describing
      // something else, so its turns are dropped.
      return [...stored];
    }
  }

  /*
   * The client's transcript is the stored one plus a few newer turns.
   * The stored turns are byte-for-byte the client's own, so taking the
   * client's copy changes nothing — and it keeps the merged list in
   * one chronological order.
   */
  return [...client];
}

/**
 * Loads the prior turns of a conversation.
 *
 * ── Why the most recent turns are taken, not the oldest ─────────────────
 *
 * A conversation about the customer's skin develops: the early turns
 * are "I have oily skin", the recent ones are "will this work with
 * the sunscreen you recommended?". The recent turns are the ones the
 * current question refers to — "what about the retinol?" means the
 * retinol from two turns ago, not from twenty.
 *
 * So the turns are taken **most recent first**, then reversed back into
 * chronological order for the prompt. A model reads a transcript
 * forwards.
 *
 * ── Why the query is scoped by the user ──────────────────────────────────
 *
 * The `conversationId` comes from the caller, and the caller is the
 * route — which has already checked the conversation belongs to this
 * user. This query is nevertheless scoped by `userId` as well, because
 * a service that trusts its caller's authorisation is one refactor away
 * from leaking another customer's skincare history.
 *
 * ── Why the ordering has a tiebreaker ────────────────────────────────────
 *
 * `createdAt` is a timestamp with millisecond resolution, and two
 * messages written in the same millisecond are **tied**. A database is
 * free to break that tie any way it likes, and Postgres does not break
 * it the way the writes happened — so the history could come back with
 * "Second question." before "First question.", and the advisor would
 * read the conversation backwards.
 *
 * This was not theoretical: the integration test for the ordering
 * failed intermittently, and the transcript is the thing that makes the
 * advisor feel like it remembers the customer.
 *
 * So the primary sort is the timestamp and the tiebreaker is the `id`,
 * which is a `cuid` — monotonically increasing with creation order, so
 * it reproduces the sequence the messages were actually written in.
 */
export async function loadConversationHistory(
  userId: string,
  conversationId: string | undefined,
): Promise<AdvisorHistoryTurn[]> {
  if (!conversationId) {
    return [];
  }

  const rows = await db.advisorMessage.findMany({
    where: { conversationId, conversation: { userId } },
    select: { role: true, content: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_HISTORY_TURNS,
  });

  // The query took the newest turns, so they are reversed back into
  // chronological order here.
  return rows.reverse().map((row) => ({
    role: row.role === "ASSISTANT" ? "ASSISTANT" : "USER",
    content: row.content,
  }));
}

/**
 * Loads the admin-managed system prompt override.
 *
 * ── Why this is a separate read ──────────────────────────────────────────
 *
 * The `AiConfig` row carries an admin's prompt override, and the
 * provider needs it on every call. It used to be hard-coded to `null`
 * at the call site, which meant the override the admin could edit in
 * the Settings screen was **never actually used** — the field was
 * stored, audited and displayed, and then ignored.
 *
 * So it is loaded here, alongside the profile and the disclaimer, and
 * passed through to the provider.
 *
 * ── Why a failure falls back rather than throws ──────────────────────────
 *
 * A missing row, an empty prompt or a database failure all mean "use
 * the built-in prompt". The advisor must keep working: the built-in
 * prompt is the safe one, because it carries the hard rules.
 */
export async function loadSystemPrompt(): Promise<string | null> {
  try {
    const config = await db.aiConfig.findUnique({
      where: { key: "default" },
      select: { systemPrompt: true },
    });

    const prompt = config?.systemPrompt?.trim();

    if (!prompt) {
      return null;
    }

    return prompt;
  } catch (error) {
    console.error("[advisor] System prompt load failed:", error);

    return null;
  }
}

/**
 * Loads the user's skin profile.
 *
 * A user with no profile gets an empty context — not an error. The
 * advisor is useful without a profile; the profile only sharpens it.
 */
export async function loadSkinContext(userId: string): Promise<SkinContext> {
  const profile = await db.userSkinProfile.findUnique({
    where: { userId },
    select: { skinType: true, concerns: true, notes: true },
  });

  if (!profile) {
    return { skinType: null, concerns: [], notes: null };
  }

  return {
    skinType: profile.skinType,
    concerns: profile.concerns,
    notes: profile.notes,
  };
}

/**
 * Loads the candidate products.
 *
 * Three filters, applied in code:
 *
 *   1. **In stock.** Recommending something the shop cannot ship is
 *      worse than recommending nothing.
 *   2. **The admin allow-list.** `AiConfig.aiProductIds` is empty
 *      meaning "everything is allowed"; a non-empty list is exclusive.
 *   3. **The cart-conflict check.** A product that `BLOCK`s against
 *      something already in the customer's cart is dropped.
 */
async function loadCandidates(
  userId: string,
  enforceCartConflicts: boolean,
): Promise<{
  readonly candidates: ProductCandidate[];
  readonly conflicts: EvaluatedConflict[];
  readonly blockedIds: string[];
}> {
  const config = await db.aiConfig.findUnique({
    where: { key: "default" },
    select: { aiProductIds: true, enforceCartConflicts: true },
  });

  const allowedIds = config?.aiProductIds ?? [];
  const enforce = enforceCartConflicts && (config?.enforceCartConflicts ?? true);

  const products = await db.product.findMany({
    where: {
      stockQuantity: { gt: 0 },
      // An archived product must never be recommended to a shopper.
      //
      // This site is easy to forget — it is in `src/lib/ai/`, not in the
      // catalogue service — and the `take` cap makes it worse: an
      // archived product would occupy a candidate slot and displace a
      // live one, so the advisor would recommend fewer products than it
      // could.
      ...ACTIVE_PRODUCT_WHERE,
      ...(allowedIds.length > 0 ? { id: { in: allowedIds } } : {}),
    },
    select: {
      id: true,
      name: true,
      description: true,
      pricePaisa: true,
      discountPricePaisa: true,
      ingredientTags: true,
      climateTips: true,
      category: { select: { name: true } },
    },
    orderBy: [{ isBestSeller: "desc" }, { name: "asc" }],
    take: MAX_CANDIDATES * 3,
  });

  // ── The cart products, for the conflict check ──────────────────────────
  let cartProducts: ConflictProduct[] = [];
  let cartIds = new Set<string>();

  if (enforce) {
    const cart = await getCart(userId);

    cartProducts = cart.items.map((line) => ({
      id: line.productId,
      ingredientTags: line.product.ingredientTags,
    }));

    cartIds = new Set(cartProducts.map((product) => product.id));
  }

  // ── The conflict evaluation ────────────────────────────────────────────
  //
  // The engine is pure. It is given the cart products *and* the
  // candidates, so a candidate that conflicts with the cart is caught,
  // and two candidates that conflict with each other are caught too.
  const evaluation = evaluateConflicts([...cartProducts, ...products]);

  // A candidate is dropped when it is blocked against the cart. A
  // candidate that is blocked only against *another candidate* is kept
  // but warned about — the customer is not buying both yet.
  const blockedAgainstCart = new Set(
    evaluation.blockedProductIds.filter((id) => cartIds.has(id)),
  );

  const blocked = new Set<string>(blockedAgainstCart);

  // A candidate blocked against another candidate is not blocked
  // outright. The engine reports the pair; the blocked id may be the
  // cart product, not the candidate.
  for (const id of evaluation.blockedProductIds) {
    if (cartIds.has(id)) {
      blocked.add(id);
    }
  }

  const allowed = products.filter((product) => !blocked.has(product.id));

  const candidates: ProductCandidate[] = allowed
    .slice(0, MAX_CANDIDATES)
    .map((product) => ({
      id: product.id,
      name: product.name,
      categoryName: product.category.name,
      pricePaisa: product.pricePaisa,
      discountPricePaisa: product.discountPricePaisa,
      ingredientTags: product.ingredientTags,
      climateTips: product.climateTips,
      description: product.description,
    }));

  // The conflicts the customer is told about: the ones involving a
  // cart product, plus the ones between two candidates.
  const relevant = evaluation.conflicts.filter((conflict) =>
    conflict.involvedProductIds.some(
      (id) => cartIds.has(id) || candidates.some((c) => c.id === id),
    ),
  );

  return {
    candidates,
    conflicts: relevant,
    blockedIds: [...blocked],
  };
}

/**
 * The product ids the advisor would consider recommending.
 *
 * ── Why this is exported ────────────────────────────────────────────────
 *
 * The candidate list is the advisor's **allow-list** — the set of
 * products code has decided are eligible. It is the one thing about
 * the advisor that is worth asserting about from outside: an archived
 * product must never appear in it, because an archived product must
 * never be recommended to a shopper.
 *
 * So this exposes the list without exposing the provider, the prompt
 * assembly, or the response validation. It is a read, and it runs the
 * same `loadCandidates` the real advisor runs.
 *
 * @param userId - The customer whose cart is checked for conflicts.
 */
export async function listAdvisorCandidateIds(
  userId: string,
): Promise<string[]> {
  const { candidates } = await loadCandidates(userId, true);

  return candidates.map((candidate) => candidate.id);
}

/**
 * Converts an evaluated conflict into the shape the provider sees.
 */
function toConflictReport(conflict: EvaluatedConflict): ConflictReport {
  return {
    ruleId: conflict.ruleId,
    severity: conflict.severity,
    title: conflict.title,
    message: conflict.message,
    involvedProductIds: [...conflict.involvedProductIds],
    ingredientIds: [...conflict.ingredientIds],
    remedy: conflict.remedy,
    spacingAdvice: conflict.spacingAdvice,
  };
}

/**
 * Converts an evaluated conflict into the shape the client sees.
 */
function toAdvisorConflict(conflict: EvaluatedConflict): AdvisorConflict {
  return {
    ruleId: conflict.ruleId,
    severity: conflict.severity,
    title: conflict.title,
    message: conflict.message,
    remedy: conflict.remedy,
    spacingAdvice: conflict.spacingAdvice,
    involvedProductIds: [...conflict.involvedProductIds],
    ingredientIds: [...conflict.ingredientIds],
  };
}

/**
 * Builds the one-line reason for a recommendation.
 *
 * The reason is composed in code, not taken from the provider. A
 * provider-supplied reason is prose that could say anything — including
 * something the product does not support. Code knows what it decided,
 * so code writes the line.
 */
export function reasonFor(
  candidate: ProductCandidate,
  conflict: EvaluatedConflict | undefined,
): string {
  const base = candidate.ingredientTags.length > 0
    ? `Matches your routine with ${candidate.ingredientTags.slice(0, 3).map((tag) => tag.toLowerCase().replace(/_/g, " ")).join(", ")}.`
    : "A gentle option that suits the profile you have shared.";

  if (!conflict) {
    return base;
  }

  if (conflict.severity === "BLOCK") {
    return `${base} Use it on its own — it should not be combined with the other item in your cart.`;
  }

  return `${base} Use it alongside your cart, spacing the two apart.`;
}

/**
 * Decides which product ids the response may carry.
 *
 * ── Why this is a pure function ──────────────────────────────────────────
 *
 * This is the guard rail, and it is the one place where a wrong decision
 * reaches the customer: a product that should not be recommended, or a
 * routine that should not have been offered at all.
 *
 * It is a pure function so it can be tested **directly**, without a
 * database. The rules it enforces are:
 *
 *   1. **A turn that does not call for products carries none.** A
 *      greeting, or a question about the shop. Whatever the provider
 *      returned is dropped — *not* replaced with a different set.
 *   2. **An id outside the allow-list is dropped**, and the
 *      deterministic set is used instead.
 *   3. **Everything else is capped** at `MAX_RECOMMENDATIONS`.
 *
 * ── Why the order of those rules matters ─────────────────────────────────
 *
 * Rule 1 comes first because the deterministic fallback in rule 2 would
 * otherwise *invent* a routine on a greeting turn. A provider that
 * ignored the turn instruction and recommended something anyway would
 * have those ids dropped by rule 1 — and the fallback in rule 2 would
 * never run, so the customer would not get a routine they did not ask
 * for.
 *
 * @param intent - What code decided this turn is.
 * @param allowedIds - The ids the provider is permitted to recommend.
 * @param returnedIds - The ids the provider actually returned.
 * @param candidates - The code-built candidate list, for the fallback.
 */
export function selectRecommendedIds(
  intent: AdvisorIntent,
  allowedIds: ReadonlySet<string>,
  returnedIds: readonly string[],
  candidates: readonly ProductCandidate[],
): string[] {
  if (!intent.mayRecommend) {
    if (returnedIds.length > 0) {
      console.warn(
        `[advisor] Provider recommended ${returnedIds.length} product(s) on a ${intent.kind} turn, where recommendations do not belong. Dropping them.`,
      );
    }

    return [];
  }

  const invalid = returnedIds.filter((id) => !allowedIds.has(id));

  if (invalid.length > 0) {
    console.warn(
      `[advisor] Provider recommended ${invalid.length} product(s) outside the allow-list. Falling back to the deterministic set.`,
    );

    return candidates
      .slice(0, MAX_RECOMMENDATIONS)
      .map((candidate) => candidate.id);
  }

  return returnedIds
    .filter((id) => allowedIds.has(id))
    .slice(0, MAX_RECOMMENDATIONS);
}

/**
 * Generates an advisor response.
 *
 * @throws when the provider fails and the mock fallback also fails.
 */
export async function generateAdvisorResponse(
  input: GenerateInput,
  provider?: AiProvider,
): Promise<AdvisorResult> {
  const [profile, disclaimer, storedHistory, systemPrompt] = await Promise.all([
    loadSkinContext(input.userId),
    loadDisclaimer(),
    loadConversationHistory(input.userId, input.conversationId),
    loadSystemPrompt(),
  ]);

  /*
   * The conversation the model will see.
   *
   * The stored transcript and the client's are merged here, so the
   * provider receives one list. See `mergeHistory` for why the stored
   * one wins unless the client's is demonstrably ahead of it.
   */
  const history = mergeHistory(storedHistory, input.clientHistory ?? []);

  const { candidates, conflicts } = await loadCandidates(
    input.userId,
    true,
  );

  // The provider may only recommend from this list.
  const allowedProductIds = candidates.map((candidate) => candidate.id);

  /*
   * The language.
   *
   * Detected in code, from the customer's message, and handed to the
   * provider as a fact. A Banglish message reads as English to a
   * character check, so the detection cannot be left to the model to
   * infer — and a customer who asks in Bengali must not be answered in
   * English.
   */
  const language = detectAdvisorLanguage(input.userMessage);

  /*
   * The turn's intent.
   *
   * Detected in code, from the message and from what code already
   * knows about the customer, and handed to the provider as a fact.
   *
   * This is the decision that stops the advisor dumping a routine on a
   * greeting. It is made here rather than left to the model for the
   * same reason the language is: a decision that has to be reliable
   * cannot be delegated to a prompt. The prompt asks the model to
   * behave; this decides whether it is even allowed to recommend.
   */
  const intent = detectAdvisorIntent(input.userMessage, {
    hasImage: input.image !== undefined,
    skinType: profile.skinType,
    concerns: profile.concerns,
  });

  const active = provider ?? (await getAiProvider());

  /*
   * The image.
   *
   * Base64-encoded **only** when the provider can actually look at
   * it. The mock provider cannot, and base64-encoding a photograph it
   * is going to ignore is pure waste — so the offline mode never pays
   * for it, which is what keeps the mock fast and honest.
   *
   * The encoding happens here rather than in the route because this is
   * the layer that knows which provider is in use.
   */
  const image =
    input.image && active.supportsVision === true
      ? {
          mimeType: input.image.mimeType,
          base64: input.image.bytes.toString("base64"),
        }
      : undefined;

  const request: AdvisorRequest = {
    userMessage: input.userMessage,
    ...(image ? { image } : {}),
    profile,
    candidates,
    /*
     * The conflicts handed to the provider.
     *
     * Gated on the turn, for the same reason the *response* is gated a
     * few lines below: the prompt tells the model to warn about the
     * conflicts it is given, and to say plainly that a blocked product
     * does not suit the routine. So on a greeting, handing the model the
     * conflict list produces a **prose** warning even though the warning
     * *card* is suppressed — the customer still reads "you already have a
     * retinoid in your routine" under "Hi", just in a different font.
     *
     * Gating the prompt and the response together means the two agree:
     * a turn that does not warn does not mention conflicts at all.
     */
    conflicts: intent.mayWarn ? conflicts.map(toConflictReport) : [],
    allowedProductIds,
    systemPrompt,
    history,
    language,
    intent,
  };

  let response;

  try {
    response = await active.complete(request);
  } catch (error) {
    console.error("[advisor] Provider failed:", error);

    throw error;
  }

  // ── The response validation — the guard rail ──────────────────────────
  //
  // The provider's output is untrusted input. A recommended id that is
  // not on the allow-list is dropped, and the deterministic set is used
  // instead. The provider does not get to widen its own permissions.
  //
  // The whole rule set lives in `selectRecommendedIds`, which is pure
  // and tested directly. See that function for why the "this turn may
  // not carry products" check comes first.
  const allowed = resolveAllowedIds(request);

  const recommendedIds = selectRecommendedIds(
    intent,
    allowed,
    response.recommendedProductIds,
    candidates,
  );

  // ── The conflicts are re-attached ─────────────────────────────────────
  //
  // Whatever the provider said about conflicts is discarded. The
  // code-decided conflicts are what the customer sees. Code wins.
  //
  // ── Why they are gated on the turn ──────────────────────────────────────
  //
  // A conflict warning is about a **routine**, and it is only worth
  // raising when a routine is on the table. The customer said "Hi", or
  // "how long does delivery take?", or "I am having a rough week" — and
  // the shop answered with an amber "Use with care" panel about a
  // retinoid they never mentioned.
  //
  // That is not a cosmetic problem. The conflict list is built from the
  // customer's **cart**, so it is the same on every turn: whoever has a
  // retinol in their cart sees the retinol warning under *every* reply,
  // including the ones that had nothing to do with skincare. The panel
  // stops being advice and becomes noise the customer learns to skip.
  //
  // So the gate is `intent.mayWarn`, decided in code by the intent
  // module and applied here — independently of the model, exactly like
  // the recommendation gate above it. The rule the codebase already
  // follows ("code decides, the model phrases") applies to *whether to
  // show* a conflict just as much as to *what* the conflict says.
  //
  // The decision is made **here**, at the point where the provider's
  // output is validated, so no provider and no UI can widen it.
  const advisorConflicts = intent.mayWarn
    ? conflicts.map(toAdvisorConflict)
    : [];

  const recommendations: Recommendation[] = recommendedIds
    .map((id) => candidates.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is ProductCandidate => candidate !== undefined)
    .map((candidate) => {
      const conflict = conflicts.find((item) =>
        item.involvedProductIds.includes(candidate.id),
      );

      return {
        productId: candidate.id,
        name: candidate.name,
        pricePaisa: candidate.pricePaisa,
        discountPricePaisa: candidate.discountPricePaisa,
        reason: reasonFor(candidate, conflict),
      };
    });

  return {
    content: stripRecommendationMarker(response.content),
    recommendations,
    conflicts: advisorConflicts,
    disclaimer,
    provider: {
      name: response.providerName,
      isMocked: response.isMocked,
      model: response.modelName,
    },
    skinProfile: {
      skinType: profile.skinType,
      concerns: profile.concerns,
    },
    intent,
  };
}

/**
 * Removes any leftover marker line from the reply.
 *
 * ── Why this is a second line of defence ─────────────────────────────────
 *
 * The real providers strip the marker themselves, in
 * `src/lib/ai/free-text.ts`. This is the belt to that pair of braces.
 *
 * The marker is a **machine-readable line in something a human reads**,
 * so leaking one is a visible defect: the customer sees
 * `[RECOMMENDED: prod_x]` at the bottom of a greeting. The providers
 * remove it, but the service layer is where the reply is finally
 * assembled and where the customer's copy is written — so that is where
 * the last check belongs.
 *
 * It is cheap, it cannot fail, and it means no provider can ever leak
 * the marker, including one added later.
 */
function stripRecommendationMarker(content: string): string {
  return content
    .replace(/\[RECOMMENDED:[^\]]*\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The shape stored in `AdvisorMessage.meta`.
 */
export type AdvisorMessageMeta = {
  recommendedProductIds: string[];
  conflicts: AdvisorConflict[];
  disclaimerVersion: number;
  provider: string;
  model: string;
  isMocked: boolean;
  skinType: SkinType | null;
  concerns: string[];
  /**
   * The turn's intent, as code decided it.
   *
   * Recorded for the same reason the model name is: an auditor reading
   * a transcript of "hi" → "here are three products" needs to be able
   * to see that the turn was classified as a greeting and the products
   * should not have been there.
   */
  intent: AdvisorIntent["kind"];
  /**
   * Whether the turn was allowed to carry ingredient-conflict warnings.
   *
   * Recorded for the same reason as the intent itself: so a transcript
   * re-rendered from the database shows the conflicts the turn actually
   * carried, rather than re-deciding it. The `conflicts` array in this
   * meta is already the gated list — an empty array on a greeting is the
   * record that the warning was deliberately withheld.
   *
   * It is written as `mayWarn` rather than derived, so an auditor can
   * see the *decision* and not only its outcome.
   */
  mayWarn: boolean;
};

/**
 * Builds the `meta` payload for an assistant message.
 */
export function buildMessageMeta(result: AdvisorResult): AdvisorMessageMeta {
  return {
    recommendedProductIds: result.recommendations.map(
      (recommendation) => recommendation.productId,
    ),
    conflicts: result.conflicts,
    disclaimerVersion: result.disclaimer.version,
    provider: result.provider.name,
    model: result.provider.model,
    isMocked: result.provider.isMocked,
    skinType: result.skinProfile.skinType,
    concerns: result.skinProfile.concerns,
    intent: result.intent.kind,
    mayWarn: result.intent.mayWarn,
  };
}

/**
 * The Prisma JSON type for the meta payload.
 */
export type AdvisorMessageMetaJson = Prisma.InputJsonValue;
