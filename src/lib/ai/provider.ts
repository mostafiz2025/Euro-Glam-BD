import type { SkinType } from "@prisma/client";

import type { AdvisorIntent } from "./intent";
import type { AdvisorLanguage } from "./language";

/**
 * The AI provider abstraction.
 *
 * ── The contract ────────────────────────────────────────────────────────
 *
 * The provider's only job is to **phrase** an outcome that code has already
 * decided. It is not allowed to decide whether a conflict exists, to
 * downgrade a severity, to add a product that was excluded, or to omit the
 * disclaimer. See DECISIONS.md #7 and spec §5.5.
 *
 * By the time `complete()` is called:
 *
 *   • `request.candidates` contains only products code has approved.
 *   • `request.conflicts` contains only conflicts code has decided.
 *   • `request.allowedProductIds` is the allow-list a response must respect
 *     (or `null`, meaning "all candidates are allowed").
 *
 * The service layer re-applies the code-decided conflicts *after* the
 * provider returns, so even a misbehaving provider cannot weaken a `BLOCK`.
 */

/**
 * The user's skin context.
 */
export type SkinContext = {
  skinType: SkinType | null;
  concerns: string[];
  notes: string | null;
};

/**
 * A product the advisor may consider recommending.
 *
 * This is a DTO, not a Prisma `Product` row. Keeping it narrow means the
 * provider cannot accidentally serialise unrelated fields (cost, stock,
 * internal ids) into a prompt.
 */
export type ProductCandidate = {
  id: string;
  name: string;
  categoryName: string;
  /** Price in poisha (1 BDT = 100 poisha). */
  pricePaisa: number;
  discountPricePaisa: number | null;
  ingredientTags: string[];
  climateTips: string | null;
  description: string;
};

/**
 * A conflict, as presented to the provider.
 *
 * The provider may rephrase `message`, but the severity and the set of
 * involved products are fixed by the engine.
 */
export type ConflictReport = {
  ruleId: string;
  severity: "BLOCK" | "WARN";
  title: string;
  message: string;
  involvedProductIds: string[];
  ingredientIds: string[];
  remedy: string;
  spacingAdvice: string;
};

/**
 * One turn in the conversation history.
 *
 * ── Why the history is a contract and not a string ───────────────────────
 *
 * The advisor is a **conversation**, not a search box. A customer who
 * said "I have oily skin" three turns ago still has oily skin, and a
 * model answering only the latest message would ask them to repeat it.
 *
 * So the prior turns are handed to the provider as structured turns,
 * not as a summary inside the prompt. The provider decides how to render
 * them — as `role`/`content` messages for a chat-completions API — and
 * the mock provider ignores them.
 *
 * The roles are the same two the database stores: a customer turn and
 * an advisor turn.
 */
export type AdvisorHistoryTurn = {
  readonly role: "USER" | "ASSISTANT";
  readonly content: string;
};

/**
 * The request handed to a provider.
 */
export type AdvisorRequest = {
  userMessage: string;
  /**
   * The user's uploaded image.
   *
   * `base64` is only populated for a provider that supports vision. The
   * mock provider never needs it, so the service layer can leave it empty
   * and avoid carrying megabytes around for no reason.
   */
  image?: { mimeType: string; base64: string };
  profile: SkinContext;
  /** The products under consideration, already filtered by code. */
  candidates: ProductCandidate[];
  /** The conflicts code has decided, already filtered by code. */
  conflicts: ConflictReport[];
  /**
   * The ids the provider may recommend.
   *
   * `null` means "every candidate is allowed". A non-null list is the
   * allow-list — a provider that returns an id outside it has that id
   * dropped by the response validator.
   */
  allowedProductIds: string[] | null;
  /** An admin-managed override of the default system prompt. */
  systemPrompt: string | null;
  /**
   * The prior turns of this conversation, oldest first.
   *
   * Empty for the first turn. The service layer caps the number of
   * turns it loads, so this is a bounded list.
   */
  history?: readonly AdvisorHistoryTurn[];
  /**
   * The language the customer wrote in, already detected in code.
   *
   * The provider does not guess it. A Banglish message looks like
   * English to a character check, so the detection is done once, in
   * code, and handed over as a fact.
   */
  language?: AdvisorLanguage;
  /**
   * What this turn is, already decided in code.
   *
   * The same reasoning as the language: whether a turn should carry
   * product recommendations is a *decision*, and by the "code decides,
   * the model phrases" rule it cannot be delegated to the prompt.
   *
   * A greeting turn has `mayRecommend: false`, and the service layer
   * enforces that regardless of what the model returns. See
   * `src/lib/ai/intent.ts`.
   */
  intent?: AdvisorIntent;
};

/**
 * The response from a provider.
 *
 * `recommendedProductIds` is **untrusted** until the service layer has
 * validated it against the allow-list. The provider does not get to widen
 * its own permissions.
 */
export type AdvisorResponse = {
  content: string;
  recommendedProductIds: string[];
  providerName: string;
  modelName: string;
  /** True when the deterministic mock produced this response. */
  isMocked: boolean;
};

/**
 * The provider interface.
 */
export interface AiProvider {
  /** The provider identifier recorded on `AdvisorMessage.provider`. */
  readonly name: string;
  /** The model identifier recorded on `AdvisorMessage.model`. */
  readonly modelName: string;
  /**
   * Whether this provider can look at an image.
   *
   * The service layer uses it to decide whether to base64-encode the
   * customer's photograph at all. A provider that cannot see images
   * gains nothing from the encoding, and the mock provider — which
   * must stay fast, offline and dependency-free — would otherwise pay
   * to encode a picture it then ignores.
   */
  readonly supportsVision?: boolean;
  /**
   * Produces a response for the given request.
   *
   * @throws AiProviderError when the provider is unavailable or returns
   *         an unusable response. The API error handler converts this
   *         into a 502 — see `handleApiError` in `src/lib/api/errors.ts`.
   */
  complete(request: AdvisorRequest): Promise<AdvisorResponse>;
}

/**
 * The error thrown when a provider fails.
 *
 * A dedicated class so the service layer can distinguish "the provider is
 * broken" (502, retryable) from "the request was invalid" (400).
 */
export class AiProviderError extends Error {
  readonly providerName: string;
  readonly cause?: unknown;

  constructor(providerName: string, message: string, cause?: unknown) {
    super(message);
    this.name = "AiProviderError";
    this.providerName = providerName;
    this.cause = cause;
  }
}

/**
 * The default system prompt.
 *
 * ── What it is made of ───────────────────────────────────────────────────
 *
 * Two layers, and the order matters.
 *
 * **1. The persona and behaviour** — the shop's own instructions. It
 * makes the advisor a conversational skin expert, makes it answer in
 * the customer's language, makes it read a photo before advising on it,
 * makes it aware of Bangladesh's climate, and makes it recommend only
 * the European brands the shop actually stocks.
 *
 * **2. The hard rules** — what the model may not do. These are the
 * guardrails the codebase has always relied on, and they are enforced
 * *again* in code (the service layer drops an out-of-allow-list product
 * id, and re-attaches the code-decided conflicts regardless of what the
 * model said).
 *
 * The duplication is deliberate. A prompt rule is a request; a code
 * rule is a guarantee. Both exist because the prompt makes the model
 * behave and the code makes it *unable* to misbehave. If only the prompt
 * existed, a sufficiently determined model could talk itself into
 * recommending a blocked product; if only the code existed, the answer
 * would read like a form letter rather than advice.
 *
 * ── Why the conflict rules come first ────────────────────────────────────
 *
 * The candidate list and the conflict list are the two facts the model
 * is most likely to get wrong, and getting them wrong is the failure
 * that matters — a blocked product in a routine, or a conflict dropped
 * because the model did not feel like mentioning it. So they are stated
 * before the softer behavioural guidance.
 *
 * ── Why there is no answer-format section any more ───────────────────────
 *
 * There used to be one, and it was the reason the advisor did not sound
 * like a person. A JSON schema — and, before it, an instruction to
 * "answer briefly, then list products with one line of reasoning each" —
 * tells the model *how to shape its answer*, and a model told to shape
 * its answer writes a shaped answer.
 *
 * The advisor now speaks in **plain prose with no format constraints at
 * all**. The only machine-readable thing it emits is the single
 * recommendation line, which the provider strips before the customer
 * sees it. Everything else — how long it is, how it opens, whether it
 * uses a list, whether it ends with a question — is the model's own
 * judgement, and that is the point.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  `You are the official AI Skincare Advisor for "Euro Glam BD", an e-commerce platform specializing in authentic European skincare and cosmetics in Bangladesh.`,
  "",
  "Who you are:",
  "You are a warm, knowledgeable skincare expert talking to a customer of our shop. You are a person, not a catalogue and not a search box. You have been helping people with their skin for years, and you care about getting it right for them.",
  "",
  "How to talk:",
  "- Write like you are speaking, not like you are writing a manual. Short paragraphs, ordinary words, no headings, no bullet-point walls, no numbered lists of rules.",
  "- Use the conversation you have already had. If the customer told you their skin type two turns ago, do not ask for it again — that is the single most annoying thing an assistant can do.",
  "- Be encouraging without being syrupy. Acknowledge what the customer said before you answer it.",
  "- Answer the question that was actually asked. If they asked one thing, answer that one thing.",
  "- Ask at most one question per turn, and only when you genuinely need the answer to go further.",
  "- When you do recommend something, say why it suits *them* — the skin they described, the climate they live in — in one short line each.",
  "- Keep it short. A couple of short paragraphs is plenty. This is a chat, not an essay.",
  "",
  "Your Role & Behavior:",
  "1. Chat & Conversational: Begin by greeting the customer and asking what their skin is like. Most customers arrive with almost no information, so your first job is to start the conversation, not to deliver a routine. Only bring in products once the customer has told you about their skin or asked for them.",
  "2. Language Flexibility: Detect the language the user is using. If the user speaks or asks in Bengali (or Banglish), respond naturally in fluent, polite, and clear Bengali. If they use English, respond in English. Keep product names, brand names and ingredient names in their original English in every language.",
  "3. Image Analysis: If the user uploads a photo of their skin or a skin concern (acne, dark spots, redness, texture), analyze the visual symptoms carefully, acknowledge them, and explain what might be happening before giving product recommendations.",
  "4. Climate & Context Awareness: Keep Bangladesh's hot and humid climate in mind when suggesting skincare routines — lightweight non-comedogenic sunscreens, oil control, and proper hydration.",
  "5. Product Recommendations: Recommend authentic European skincare brands available on Euro Glam BD (such as CeraVe, The Ordinary, La Roche-Posay, Paula's Choice, Cosrx, etc.). Match products accurately to the user's skin type (Oily, Dry, Combination, Sensitive, Acne-prone) and specific concerns (Acne, Dark spots, Dullness, Large pores). Recommend only when the conversation has actually earned it — never because a catalogue was supplied.",
  "6. Safety & Disclaimer: Always include a gentle disclaimer that your advice is for aesthetic skincare routines and not a medical prescription from a dermatologist, especially for severe skin conditions. Never suggest unsafe ingredient combinations (e.g. mixing high-strength Retinol and AHA/BHA carelessly without warning).",
  "",
  "How to run the conversation:",
  "- Read the turn instruction that follows these rules. It tells you what the customer just did — whether they greeted you, described a skin concern, or asked a specific question — and it tells you what this turn should contain. Follow it exactly.",
  "- A greeting is answered with a greeting. Say hello back, ask what their skin type is, and ask what they are struggling with. Nothing else.",
  "- Do not open every turn with products. A customer who has said \"hi\" has not asked for a routine, and a customer who asked one question has asked one question. Recommending at that moment makes the advisor feel like a salesperson interrupting a conversation.",
  "- When you do recommend, say why each product fits the customer they described, in one short line. Three products maximum, and only the relevant ones.",
  "",
  "Hard rules:",
  "- Never claim to diagnose a skin condition, and never name a condition as if you had identified it from an image.",
  "- Never recommend prescription-strength actives or advise on their dosage.",
  "- If the customer describes a persistent or severe concern, advise them to consult a dermatologist.",
  "- Recommend only the products listed in the candidate list. Never invent a product, and never recommend one that is not listed.",
  "- The conflict list has already been determined by code. Do not contradict it, do not downgrade its severity, and do not omit a conflict.",
  "- If a product is blocked because of a conflict, say plainly that it does not suit their current routine and suggest the remedy instead.",
  "- Do not use ingredient names you were not given. Do not speculate about ingredients that are not listed.",
  "- Never recommend a product on a turn that does not call for one. Recommending nothing is a correct and expected answer.",
  "",
  "How to report what you recommended:",
  "- Your reply to the customer is plain prose. The customer reads only that.",
  "- After your prose, output exactly one final line listing the products you recommended in it, in this form:",
  "[RECOMMENDED: id1, id2]",
  "- If you recommended nothing, output exactly:",
  "[RECOMMENDED: none]",
  "- Use the product ids from the candidate list. Never write anything after that line.",
].join("\n");

/**
 * The hardcoded disclaimer fallback.
 *
 * The authoritative text lives in the `AiConfig` table, but there is always
 * a fallback — never "no disclaimer". See spec §5.4.
 */
export const FALLBACK_DISCLAIMER =
  "This is an aesthetic/skincare suggestion, not a medical prescription from a doctor.";

/**
 * Formats a price in poisha as Bangladeshi Taka.
 *
 * Prices are stored as integer poisha; 1 BDT = 100 poisha. Formatting
 * happens at the edge of the system so no float ever enters the pipeline.
 */
export function formatPricePaisa(pricePaisa: number): string {
  const taka = Math.floor(pricePaisa / 100);
  const paisa = pricePaisa % 100;

  const takaFormatted = taka.toLocaleString("en-BD");

  if (paisa === 0) return `৳${takaFormatted}`;

  return `৳${takaFormatted}.${paisa.toString().padStart(2, "0")}`;
}

/**
 * Builds the catalogue lines shown to a provider.
 *
 * Kept separate from the providers so the mock and the OpenAI provider
 * describe products identically. A difference between the two would make
 * the mock useless as a stand-in for the real thing.
 */
export function describeCandidates(
  candidates: readonly ProductCandidate[],
): string {
  if (candidates.length === 0) {
    return "(no products are available for this request)";
  }

  return candidates
    .map((candidate) => {
      const price = formatPricePaisa(
        candidate.discountPricePaisa ?? candidate.pricePaisa,
      );

      const discounted =
        candidate.discountPricePaisa !== null &&
        candidate.discountPricePaisa !== candidate.pricePaisa;

      const lines = [
        `- id: ${candidate.id}`,
        `  name: ${candidate.name}`,
        `  category: ${candidate.categoryName}`,
        `  price: ${price}${discounted ? " (discounted)" : ""}`,
        `  ingredients: ${candidate.ingredientTags.length > 0 ? candidate.ingredientTags.join(", ") : "not listed"}`,
        `  description: ${candidate.description}`,
      ];

      if (candidate.climateTips) {
        lines.push(`  climate tip: ${candidate.climateTips}`);
      }

      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Builds the conflict lines shown to a provider.
 */
export function describeConflicts(conflicts: readonly ConflictReport[]): string {
  if (conflicts.length === 0) {
    return "(no ingredient conflicts were detected)";
  }

  return conflicts
    .map((conflict) => {
      const involved = conflict.involvedProductIds.join(", ");

      return [
        `- [${conflict.severity}] ${conflict.ruleId}: ${conflict.title}`,
        `  products: ${involved}`,
        `  ingredients: ${conflict.ingredientIds.join(", ")}`,
        `  why: ${conflict.message}`,
        `  remedy: ${conflict.remedy}`,
        `  spacing: ${conflict.spacingAdvice}`,
      ].join("\n");
    })
    .join("\n");
}

/**
 * The set of product ids the provider is permitted to recommend.
 *
 * Derived from `allowedProductIds` when present, otherwise from the
 * candidate list.
 */
export function resolveAllowedIds(request: AdvisorRequest): Set<string> {
  if (request.allowedProductIds !== null) {
    return new Set(request.allowedProductIds);
  }

  return new Set(request.candidates.map((candidate) => candidate.id));
}
