import { createHash } from "node:crypto";

import {
  describeCandidates,
  describeConflicts,
  formatPricePaisa,
  resolveAllowedIds,
  type AdvisorRequest,
  type AdvisorResponse,
  type AiProvider,
} from "./provider";

/**
 * The deterministic mock provider.
 *
 * ── Why deterministic ────────────────────────────────────────────────────
 *
 * The demo must be reproducible and CI must be able to assert exact output.
 * More importantly, the mock is the platform's proof that the whole
 * pipeline works with no API key and no network — which matters for a
 * project that other people will run.
 *
 * Therefore this provider uses **no `Math.random()` and no `Date.now()`**.
 * The template choice is derived from a SHA-256 hash of the request, so the
 * same input always produces byte-identical output.
 *
 * ── Why it is conversational ─────────────────────────────────────────────
 *
 * The mock has to behave like the real providers, because the mock is
 * what most people actually run. If the mock dumped a three-product
 * routine on "hi" while Gemini greeted the customer back, the demo would
 * contradict the product — and the mock's whole job is to be a faithful
 * stand-in.
 *
 * So the mock follows the same turn contract: a greeting turn greets and
 * asks, a concern turn answers and recommends, a question turn answers.
 * It has no model, so it cannot improvise — the *phrasing* comes from
 * templates and the *decision* comes from the same `intent` the real
 * providers are given.
 */

/**
 * The provider name recorded on messages.
 */
export const MOCK_PROVIDER_NAME = "mock";

/**
 * The model name recorded on messages.
 */
export const MOCK_MODEL_NAME = "mock-deterministic-v1";

/**
 * The openers used on an advice turn.
 *
 * Selected by hash, so the same question always gets the same opener.
 */
const ADVICE_OPENERS = [
  "Thanks for telling me — here is what I would suggest.",
  "Good question. Based on what you have told me, here is my recommendation.",
  "Happy to help. Here is how I would build this for you.",
  "Let me walk you through what fits your routine best.",
];

/**
 * The openers used on a greeting turn.
 *
 * A greeting is answered with a greeting — and a question back. Never
 * with a product list.
 */
const GREETING_OPENERS = [
  "Hello! I am glad you stopped by.",
  "Hi there! Good to meet you.",
  "Hello — welcome to Euro Glam BD.",
  "Hi! I am here to help with your skin.",
];

/**
 * The questions a greeting turn ends with.
 *
 * The advisor asks what the skin is like and what the customer is
 * struggling with. One question, one turn — a customer who is asked
 * four things at once answers none of them.
 */
const GREETING_QUESTIONS = [
  "To start, what is your skin type — oily, dry, combination, sensitive, or acne-prone?",
  "First, tell me about your skin: is it oily, dry, combination, or sensitive?",
  "Let us start with your skin type. Is it mostly oily, dry, combination, or sensitive?",
  "Before I suggest anything, what kind of skin do you have — oily, dry, combination, or sensitive?",
];

/**
 * The follow-up question, used when the advisor still needs to know.
 */
const SKIN_TYPE_QUESTION =
  "What is your skin type — oily, dry, combination, sensitive, or acne-prone?";

/**
 * The follow-up question about concerns.
 */
const CONCERNS_QUESTION =
  "And what is bothering you most — acne, dark spots, dullness, large pores, dryness, or sensitivity?";

/**
 * The opening lines used when there are no candidates to recommend.
 */
const NO_CANDIDATES = [
  "I do not have a product that suits this request right now.",
  "Nothing in the current catalogue is a good match for what you asked for.",
  "I cannot find a suitable product for this particular need at the moment.",
];

/**
 * The closing lines.
 */
const CLOSINGS = [
  "Introduce one new product at a time, and give your skin a week to adjust before adding the next.",
  "If your skin feels irritated, stop and simplify your routine — less is more while it settles.",
  "Sunscreen every morning makes a real difference, especially in Bangladesh's heat and humidity.",
  "Patch-test anything new on a small area first, especially if your skin is sensitive.",
];

/**
 * The templates used to open the conflict section.
 */
const CONFLICT_OPENERS = [
  "There is one thing to sort out before you combine these.",
  "Before you add anything else, there is a combination worth flagging.",
  "One caution about combining these products.",
];

/**
 * Derives a stable numeric seed from the request.
 *
 * The seed input includes every part of the request that can change the
 * answer: the user's message, the candidate ids, the conflict rule ids, the
 * skin type, and the turn's intent. It deliberately does **not** include the
 * image bytes — the mock does not analyse images, and hashing megabytes on
 * every request would be wasteful.
 */
function seedFor(request: AdvisorRequest): number {
  const material = [
    request.userMessage.trim(),
    request.profile.skinType ?? "unknown",
    request.profile.concerns.slice().sort().join(","),
    request.candidates.map((candidate) => candidate.id).sort().join(","),
    request.conflicts.map((conflict) => conflict.ruleId).sort().join(","),
    request.intent?.kind ?? "unknown",
  ].join("|");

  const digest = createHash("sha256").update(material).digest();

  // The first four bytes as an unsigned 32-bit integer.
  return digest.readUInt32BE(0);
}

/**
 * Picks a template deterministically from a list.
 */
function pick<T>(templates: readonly T[], seed: number, salt: number): T {
  const index = (seed + salt) % templates.length;

  return templates[index] as T;
}

/**
 * Builds the sentence describing one product.
 */
function describeProduct(
  candidate: AdvisorRequest["candidates"][number],
): string {
  const price = formatPricePaisa(
    candidate.discountPricePaisa ?? candidate.pricePaisa,
  );

  const ingredientNote =
    candidate.ingredientTags.length > 0
      ? ` It contains ${candidate.ingredientTags.join(", ").toLowerCase().replace(/_/g, " ")}.`
      : "";

  const climateNote = candidate.climateTips ? ` ${candidate.climateTips}` : "";

  return `${candidate.name} (${price}) — ${candidate.description}${ingredientNote}${climateNote}`;
}

/**
 * The deterministic mock provider.
 */
export class MockProvider implements AiProvider {
  readonly name = MOCK_PROVIDER_NAME;
  readonly modelName = MOCK_MODEL_NAME;

  /**
   * The mock does not look at images.
   *
   * It has no vision model behind it, and its answers are derived from
   * a hash of the request — so the photo could not change its output
   * anyway. Declaring this means the service layer does not base64-encode
   * a photograph that the mock is going to ignore.
   */
  readonly supportsVision = false;

  /**
   * Produces a deterministic response.
   *
   * The recommendations are drawn only from `request.candidates`, and the
   * ids are intersected with the allow-list before being returned. The
   * conflicts in the response are exactly the ones code supplied — the mock
   * never invents, drops or downgrades one.
   */
  async complete(request: AdvisorRequest): Promise<AdvisorResponse> {
    const seed = seedFor(request);
    const allowed = resolveAllowedIds(request);

    const recommendable = request.candidates.filter((candidate) =>
      allowed.has(candidate.id),
    );

    /*
     * The turn's intent decides the shape of the answer.
     *
     * The mock honours exactly the same contract as the real providers:
     * a turn that does not call for products gets no products. Without
     * this the demo would contradict the behaviour the storefront
     * ships with.
     */
    const intent = request.intent;

    if (intent && !intent.mayRecommend) {
      return this.completeWithoutProducts(request, seed);
    }

    const recommendedProductIds = recommendable
      .map((candidate) => candidate.id)
      .sort()
      .slice(0, 3);

    const sections: string[] = [];

    // ── Opening ──────────────────────────────────────────────────────────
    sections.push(pick(ADVICE_OPENERS, seed, 1));

    // ── Skin context acknowledgement ─────────────────────────────────────
    const contextNote = this.describeContext(request);
    if (contextNote) {
      sections.push(contextNote);
    }

    // ── Conflicts — code-decided, never invented ─────────────────────────
    if (request.conflicts.length > 0) {
      sections.push(this.describeConflictSection(request));
    }

    // ── Recommendations ──────────────────────────────────────────────────
    if (recommendedProductIds.length === 0) {
      sections.push(pick(NO_CANDIDATES, seed, 2));
    } else {
      const lines = recommendable
        .filter((candidate) => recommendedProductIds.includes(candidate.id))
        .map((candidate) => `- ${describeProduct(candidate)}`)
        .join("\n");

      sections.push(`Here is what I would suggest:\n${lines}`);
    }

    // ── The follow-up question ───────────────────────────────────────────
    //
    // A good assistant asks one thing back. The advisor asks for whatever
    // it does not already know — the skin type first, then the concerns.
    const followUp = this.describeFollowUp(request);

    if (followUp) {
      sections.push(followUp);
    }

    // ── Closing ──────────────────────────────────────────────────────────
    sections.push(pick(CLOSINGS, seed, 3));

    return {
      content: sections.join("\n\n"),
      recommendedProductIds,
      providerName: this.name,
      modelName: this.modelName,
      isMocked: true,
    };
  }

  /**
   * Produces a turn that carries no products.
   *
   * A greeting turn, or a question about the shop. The answer is a
   * greeting and a question — never a catalogue.
   */
  private completeWithoutProducts(
    request: AdvisorRequest,
    seed: number,
  ): AdvisorResponse {
    const intent = request.intent;
    const sections: string[] = [];

    if (intent?.kind === "ORDER") {
      sections.push(
        "That is a question about the shop rather than about your skin, so let me answer that directly.",
      );

      sections.push(
        "For orders, delivery and payment, our team can help you directly — and any advice I give here is about skincare routines, not the order itself.",
      );
    } else {
      sections.push(pick(GREETING_OPENERS, seed, 5));

      sections.push(
        "I am your skincare advisor for Euro Glam BD, where we stock authentic European skincare and cosmetics.",
      );

      // The greeting turn's job is to start the conversation.
      sections.push(pick(GREETING_QUESTIONS, seed, 6));
    }

    return {
      content: sections.join("\n\n"),
      recommendedProductIds: [],
      providerName: this.name,
      modelName: this.modelName,
      isMocked: true,
    };
  }

  /**
   * Acknowledges the skin profile in one sentence, when there is one.
   */
  private describeContext(request: AdvisorRequest): string | null {
    const { skinType, concerns } = request.profile;

    const parts: string[] = [];

    if (skinType) {
      parts.push(`you have ${skinType.toLowerCase().replace(/_/g, " ")} skin`);
    }

    if (concerns.length > 0) {
      parts.push(`your focus is on ${concerns.join(", ").toLowerCase()}`);
    }

    if (parts.length === 0) return null;

    return `Based on what I have — ${parts.join(" and ")} — here is how I would put this together.`;
  }

  /**
   * The one question to ask back.
   *
   * The skin type comes first because it is the broader fact — the
   * concerns can be read differently depending on it. Only one question
   * is asked per turn.
   */
  private describeFollowUp(request: AdvisorRequest): string | null {
    const missing = request.intent?.missing ?? [];

    if (missing.includes("SKIN_TYPE")) {
      return SKIN_TYPE_QUESTION;
    }

    if (missing.includes("CONCERNS")) {
      return CONCERNS_QUESTION;
    }

    return null;
  }

  /**
   * Renders the conflict section.
   *
   * Every conflict code supplied is rendered, with its severity, the
   * products involved, the reason and the remedy. The order is the order
   * code supplied, which is already deterministic (`BLOCK` first).
   */
  private describeConflictSection(request: AdvisorRequest): string {
    const blocks = request.conflicts.filter(
      (conflict) => conflict.severity === "BLOCK",
    );
    const warns = request.conflicts.filter(
      (conflict) => conflict.severity === "WARN",
    );

    const lines: string[] = [];

    if (blocks.length > 0) {
      lines.push(pick(CONFLICT_OPENERS, seedFor(request), 4));

      for (const conflict of blocks) {
        lines.push(
          [
            `**${conflict.title}** (${conflict.ruleId})`,
            conflict.message,
            `What to do: ${conflict.remedy}`,
            `Spacing: ${conflict.spacingAdvice}`,
          ].join("\n"),
        );
      }
    }

    if (warns.length > 0) {
      lines.push("A couple of smaller notes on combining these:");

      for (const conflict of warns) {
        lines.push(
          [
            `- **${conflict.title}** (${conflict.ruleId})`,
            `  ${conflict.message}`,
            `  What to do: ${conflict.remedy}`,
          ].join("\n"),
        );
      }
    }

    return lines.join("\n\n");
  }
}

/**
 * Renders the catalogue and conflicts as a plain-text brief.
 *
 * Exported for the debugging script and for tests that assert the brief is
 * built correctly — it is the same text the real provider puts in its
 * prompt, so a mismatch here would mean the mock and the real provider
 * were reasoning about different catalogues.
 */
export function renderRequestBrief(request: AdvisorRequest): string {
  return [
    "CANDIDATES:",
    describeCandidates(request.candidates),
    "",
    "CONFLICTS:",
    describeConflicts(request.conflicts),
  ].join("\n");
}
