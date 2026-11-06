/**
 * The advisor's turn-intent detection.
 *
 * ── Why this is a module of its own ───────────────────────────────────────
 *
 * The advisor used to dump a routine on every single turn. A customer who
 * typed "Hi" got three products and a two-paragraph routine, because the
 * system prompt ended with a rule that said *"Answer briefly: two or three
 * short paragraphs, then a short list of recommended products"*. That
 * instruction was unconditional, so it applied to a greeting as much as it
 * applied to a real question.
 *
 * That is not a phrasing problem. It is a **decision** problem: *should
 * this turn recommend anything at all?* And by the codebase's own rule —
 * "code decides, the model phrases" (DECISIONS.md #7) — that decision
 * cannot be left to the model.
 *
 * So the decision is made here, in code, deterministically, and handed to
 * the provider as a fact. Exactly like the language detection in
 * `language.ts`, which exists for the same reason: a decision that has to
 * be reliable and testable must not be delegated to a prompt.
 *
 * ── The four intents ──────────────────────────────────────────────────────
 *
 * **GREETING** — the customer opened the conversation, or said hello. There
 * is nothing to advise on yet. The right answer is to greet back and ask
 * what their skin is like. **No products.**
 *
 * **CONCERN** — the customer described their skin: a type, a problem, a
 * goal. This is the turn where advice is *wanted*. Products are allowed,
 * but only the ones that fit what they described.
 *
 * **QUESTION** — the customer asked about something: an ingredient, a
 * routine step, a product they already own. The right answer is to answer
 * *that*. Products are allowed, but a question is not an instruction to
 * re-sell the catalogue.
 *
 * **ORDER** — the customer asked about the shop: delivery, payment, a
 * refund, a coupon. It is a question with a different answer, and it is
 * the one kind of question that should never produce a product list.
 *
 * ── Why the distinction between CONCERN and QUESTION matters ─────────────
 *
 * Both may recommend, but they recommend for different reasons and with
 * different emphasis. A concern turn earns a routine; a question turn
 * earns an answer first. Collapsing them is how you get "what about the
 * retinol?" answered with a fresh three-product routine.
 *
 * ── What is deliberately *not* here ───────────────────────────────────────
 *
 * There is no "recommend everything" intent, and no confidence score.
 * A confidence score would be a number nobody would know how to calibrate
 * or how to test. The four intents above are a closed set that can be
 * asserted against, and that is worth more than a fuzzy fifth one.
 */

/**
 * The intent of a single advisor turn.
 */
export type AdvisorIntentKind = "GREETING" | "CONCERN" | "QUESTION" | "ORDER";

/**
 * A piece of context the advisor may still need.
 */
export type MissingDetail = "SKIN_TYPE" | "CONCERNS";

/**
 * What code has decided about this turn.
 *
 * This is the object the provider is handed. The model is told what the
 * turn is and what it is allowed to do; it is never asked to work it out.
 */
export type AdvisorIntent = {
  readonly kind: AdvisorIntentKind;
  /**
   * Whether this turn may carry product recommendations at all.
   *
   * `false` on a greeting and on an order question. This is the flag the
   * service layer enforces independently of the model — see
   * `src/lib/ai/service.ts`.
   */
  readonly mayRecommend: boolean;
  /**
   * Whether this turn may carry ingredient-conflict warnings.
   *
   * ── Why this is a separate flag from `mayRecommend` ─────────────────────
   *
   * A conflict notice is a warning about a **routine**, and a warning
   * only makes sense when a routine is on the table. On a turn that
   * recommends nothing — a greeting, a question about the shop — an
   * ingredient-conflict card is noise: the customer said "Hi", and the
   * shop answered with an amber "Use with care" panel about a retinoid
   * they have not asked about.
   *
   * It is a separate flag rather than a consequence of `mayRecommend`
   * because the two are not the same question. `mayRecommend` asks "may
   * this turn *put products in front of* the customer?" — and a question
   * like *"what does my serum already contain?"* is a question, not a
   * shopping moment. `mayWarn` asks "is there a routine here for a
   * conflict to be about?" — and on a question turn the answer is
   * usually no.
   *
   * So the rule is: a conflict may be raised on a **concern** turn — the
   * customer described their skin and advice is being given — and on a
   * question turn **only** when the answer itself is about a routine the
   * customer is building or already has.
   *
   * The decision is made in code, here, and enforced by the service
   * layer independently of the model — the same rule the whole module
   * exists for.
   */
  readonly mayWarn: boolean;
  /**
   * What the advisor still needs to know.
   *
   * Empty when the turn already carried enough context — usually because
   * the customer's skin profile already knows their skin type.
   */
  readonly missing: readonly MissingDetail[];
};

/**
 * The context the detection needs beyond the message itself.
 */
export type AdvisorIntentContext = {
  /**
   * True when the customer attached a photo to this turn.
   *
   * A photo is a concern in its own right. A customer who sends a
   * picture of their face and says "hi" wants it looked at, not a
   * greeting back.
   */
  readonly hasImage?: boolean;
  /** The skin type already on the customer's profile, if any. */
  readonly skinType?: string | null;
  /** The concerns already on the customer's profile. */
  readonly concerns?: readonly string[];
};

/**
 * A greeting turn.
 */
export const GREETING_INTENT: AdvisorIntent = {
  kind: "GREETING",
  mayRecommend: false,
  mayWarn: false,
  missing: ["SKIN_TYPE", "CONCERNS"],
};

/**
 * A turn where the customer described their skin.
 */
export function concernIntent(
  missing: readonly MissingDetail[] = [],
): AdvisorIntent {
  return { kind: "CONCERN", mayRecommend: true, mayWarn: true, missing };
}

/**
 * A turn where the customer asked a question.
 *
 * ── Why a question turn does not warn by default ──────────────────────────
 *
 * A question is not a shopping moment. "Can I use this with my
 * sunscreen?" is — but "how do I use retinol?" is not, and the question
 * is the answer to that question that matters. Warning about a conflict
 * the customer did not ask about turns a reply into a sales interruption.
 *
 * So a question turn carries `mayWarn: false`, and the one exception —
 * a question that is explicitly about combining products — is decided by
 * the caller, which can see the message.
 */
export function questionIntent(
  missing: readonly MissingDetail[] = [],
  mayWarn = false,
): AdvisorIntent {
  return { kind: "QUESTION", mayRecommend: true, mayWarn, missing };
}

/**
 * A turn about the shop rather than the skin.
 */
export function orderIntent(): AdvisorIntent {
  return { kind: "ORDER", mayRecommend: false, mayWarn: false, missing: [] };
}

/**
 * The tokens that mean "I am saying hello and nothing else".
 *
 * These are removed from a message before the greeting check, so
 * "hi, how are you?" is still a greeting but "hi my pores are huge" is
 * not.
 */
const GREETING_FILLER = new Set([
  "hi",
  "hii",
  "hiii",
  "hey",
  "heya",
  "heyy",
  "hello",
  "helo",
  "hallo",
  "salam",
  "salaam",
  "assalamualaikum",
  "assalamu",
  "alaikum",
  "am",
  "i",
  "are",
  "you",
  "how",
  "is",
  "it",
  "going",
  "today",
  "there",
  "everyone",
  "all",
  "good",
  "morning",
  "evening",
  "afternoon",
  "night",
  "hope",
  "doing",
  "well",
  "fine",
  "ok",
  "okay",
  "thanks",
  "thank",
  "greetings",
]);

/**
 * The words that mean the customer is describing their skin.
 *
 * The list is deliberately specific to *skincare*. A message that
 * mentions any of these is talking about skin, whatever else it says.
 */
const CONCERN_KEYWORDS = [
  // Skin types and skin itself.
  "oily",
  "dry",
  "combination",
  "sensitive",
  "acne prone",
  "acne-prone",
  "normal skin",
  "skin type",
  "skin is",
  "my skin",
  "skin looks",
  "my face",
  // Concerns.
  "acne",
  "pimple",
  "pimples",
  "zit",
  "zits",
  "breakout",
  "breakouts",
  "breaking out",
  "blemish",
  "blemishes",
  "blackhead",
  "blackheads",
  "whitehead",
  "whiteheads",
  "dark spot",
  "dark spots",
  "dark circle",
  "dark circles",
  "hyperpigmentation",
  "pigmentation",
  "melanin",
  "uneven tone",
  "uneven skin tone",
  "dullness",
  "dull",
  "dehydrated",
  "dehydration",
  "dryness",
  // "rough" alone is the colloquial adjective — "a rough day at work".
  // The skin complaint is "rough skin", and it needs the skin word to
  // mean anything about a complexion.
  "rough skin",
  "skin is rough",
  "texture",
  "fine line",
  "fine lines",
  "wrinkle",
  "wrinkles",
  "large pore",
  "large pores",
  "open pores",
  "clogged pores",
  "redness",
  "red",
  "flushed",
  "flushing",
  "irritated",
  "irritation",
  "itchy",
  "itching",
  "burning",
  "tingling",
  "sensitive to",
  "stings",
  "peeling",
  "flaky",
  "rash",
  "sunburn",
  "tan",
  "tanning",
  "pigment",
  "freckles",
  "scar",
  "scars",
  "acne scar",
  "acne scars",
  "darkened",
  "hair fall",
  "hairfall",
  "hair loss",
  "dandruff",
  // Goals.
  "glow",
  "glowing",
  "radiant",
  "brighten",
  "brightening",
  "even out",
  "smooth",
  "smoothing",
  "hydrated",
  "moisture",
  "oil control",
  "matte",
];

/**
 * The words that mean the customer is asking about something.
 *
 * A question mark alone is not enough — "how do I use this?" is a
 * question, but so is "which of these helps with acne?". The words
 * below are the interrogative forms that actually show up in skincare
 * chat, in English and in the Bangla romanisation this shop sees.
 */
const QUESTION_KEYWORDS = [
  "what",
  "which",
  "why",
  "how",
  "when",
  "where",
  "who",
  "can i",
  "can you",
  "should i",
  "should you",
  "do i",
  "do you",
  "does",
  "is it",
  "are they",
  "am i",
  "kivabe",
  "kemon",
  "keno",
  "ki",
  "use korbo",
  "use korte",
  "use kori",
  "hobe",
  "kora",
  "ki nibo",
  "konta",
  "koto din",
  "koto",
  "recommend",
  "suggest",
  "advise",
  "advice",
  "tell me",
  "help me",
  "difference between",
  "vs",
  "versus",
  "better",
  "difference",
];

/**
 * The phrases that name the *act of combining* two things.
 *
 * ── Why this list is separate ────────────────────────────────────────────
 *
 * A conflict warning is only worth raising when the customer is asking
 * about the routine itself — "can I use this with my sunscreen?", "what
 * should I not layer together?", "can I use retinol and niacinamide
 * together?".
 *
 * Those are the turns where an ingredient conflict is the *answer*, and
 * suppressing the warning there would withhold exactly the information
 * the customer asked for. Every other question turn stays quiet about
 * conflicts, because a warning nobody asked for reads as the advisor
 * trying to upsell a problem.
 *
 * The list is deliberately narrow. It names the *act of combining*, not
 * the ingredients — a message about "retinol" alone is not necessarily
 * about combining anything.
 *
 * ── Why this list alone is not enough ────────────────────────────────────
 *
 * "with my" and "with the" are the commonest phrasings of the question
 * the customer is actually asking — "can I use this **with my**
 * sunscreen?" — but on their own they are far too broad. "I am **with
 * my** family" and "thank you **with the** help" are not questions about
 * a routine, and treating them as such would put a conflict panel under
 * a customer's small talk.
 *
 * So a preposition alone never counts. It has to be accompanied by a
 * word that names a product or an ingredient. See
 * `ROUTINE_PRODUCT_WORDS`.
 */
const ROUTINE_COMBINATION_KEYWORDS = [
  "combine",
  "combining",
  "together",
  "alongside",
  "along with",
  "layer",
  "layering",
  "layered",
  "pair",
  "pairing",
  "same routine",
  "same day",
  "mix",
  "mixing",
  "conflict",
  "at the same time",
  "e together",
  "সাথে",
  "একসাথে",
  "মিশিয়ে",
  "ব্যবহার করে",
];

/**
 * The prepositions that connect one product to another.
 *
 * These only count when a product word is present as well. On their own
 * they are far too common in ordinary English to mean anything about a
 * skincare routine.
 */
const ROUTINE_LINKING_PREPOSITIONS = [
  "with my",
  "with the",
  "and my",
  "and the",
  "with my",
  "both",
];

/**
 * The words that name a product, a routine step, or an ingredient.
 *
 * These are what turn "with my …" into a question *about a routine*.
 * The list is short on purpose: it names the words a customer actually
 * types about a skincare routine, not every possible product noun.
 */
const ROUTINE_PRODUCT_WORDS = [
  "serum",
  "serums",
  "cream",
  "creams",
  "moisturiser",
  "moisturizer",
  "moisturiser",
  "lotion",
  "cleanser",
  "cleansing",
  "toner",
  "tonics",
  "tonic",
  "exfoliant",
  "exfoliator",
  "sunscreen",
  "sunblock",
  "spf",
  "retinol",
  "retinal",
  "retinoid",
  "niacinamide",
  "vitamin c",
  "aha",
  "bha",
  "salicylic",
  "glycolic",
  "hyaluronic",
  "azelaic",
  "bakuchiol",
  "peptides",
  "peptide",
  "ceramide",
  "ceramides",
  "oil",
  "oils",
  "cleansing oil",
  "essence",
  "toner",
  "mask",
  "masks",
  "exfoliating",
  "acids",
  "active",
  "actives",
  "routine",
  "skincare",
  "skin care",
];

/**
 * The questions that are about the *order* or the *shop*.
 *
 * These are handled conversationally and never trigger a routine — the
 * customer asked about postage, not about their skin.
 */
const ORDER_KEYWORDS = [
  "order",
  "delivery",
  "deliver",
  "shipping",
  "ship",
  "tracking",
  "track",
  "payment",
  "pay",
  "refund",
  "return",
  "exchange",
  "coupon",
  "discount",
  "offer",
  "price",
  "cost",
  "buy",
  "purchase",
  "cart",
  "in stock",
  "available",
  "whatsapp",
  "call",
  "phone",
  "address",
  "location",
  "showroom",
];

/**
 * The Bengali greeting words.
 *
 * The Bangla script is its own detection problem — `language.ts` handles
 * the *answer's* language. This list handles the *turn's* intent: a
 * Bangla-script "হ্যালো" is a greeting, and "আমার ত্বকে ব্রণ হয়" is a
 * concern.
 */
const BENGALI_GREETINGS = new Set([
  "হ্যালো",
  "হেলো",
  "হাই",
  "হায়",
  "সালাম",
  "আসসালামু",
  "আলাইকুম",
  "আসসালামু আলাইকুম",
  "শুভ",
  "সকাল",
  "শুভ সকাল",
  "সন্ধ্যা",
  "শুভ সন্ধ্যা",
  "নমস্কার",
]);

/**
 * The Bengali words that mean "I am describing my skin".
 *
 * A short list of the words a customer actually types: the skin type,
 * the common problems, and the goals.
 *
 * These are matched as **substrings**, because Bangla is agglutinative:
 * "ত্বকে" (skin, oblique) contains "ত্বক" (skin), and "ত্বকের" (genitive)
 * contains it too. A whole-token match would miss every inflected form,
 * which is most of them.
 */
const BENGALI_CONCERN_KEYWORDS = [
  "ত্বক",
  "স্কিন",
  "ব্রণ",
  "ব্রন",
  "ব্ল্যাকহেড",
  "ডার্ক",
  "দাগ",
  "তেলতেলে",
  "শুষ্ক",
  "সেনসিটিভ",
  "স্পর্শক",
  "লালচে",
  "চুলকানো",
  "জ্বালা",
  "উজ্জ্বল",
  "ঝলমলে",
  "উপাদান",
];

/**
 * The Bengali question words.
 */
const BENGALI_QUESTION_KEYWORDS = [
  "কিভাবে",
  "কিবাবে",
  "কেন",
  "কোন",
  "কি",
  "কী",
  "কতদিন",
  "কত",
  "করবো",
  "করে",
  "বলুন",
  "বলো",
  "পরামর্শ",
];

/**
 * Normalises a message for matching.
 *
 * Lower-cased, punctuation removed, whitespace collapsed.
 *
 * ── Why the marks are kept ───────────────────────────────────────────────
 *
 * The character class includes `\p{M}` — the combining marks — because
 * Bangla depends on them. The virama (্) and the vowel signs are
 * marks, not letters, and stripping them turns "ত্বকে" into "তকে" and
 * "হ্যালো" into "হযাল". A normalisation that mangles the script it is
 * meant to read is worse than no normalisation at all, so the marks stay.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits a normalised message into word tokens.
 */
function tokens(text: string): string[] {
  return text.split(" ").filter((token) => token.length > 0);
}

/**
 * Whether the message contains any of the given phrases.
 *
 * Multi-word phrases are matched as substrings of the normalised text;
 * single words are matched as whole tokens. A substring match on a
 * multi-word phrase is what lets "my skin is very oily" contain
 * "skin is", and what stops "skin" alone from matching "skincare".
 */
function containsAny(text: string, phrases: readonly string[]): boolean {
  const words = tokens(text);

  for (const phrase of phrases) {
    if (phrase.includes(" ")) {
      if (text.includes(phrase)) return true;

      continue;
    }

    if (words.includes(phrase)) return true;
  }

  return false;
}

/**
 * Whether the message contains any of the given phrases, as substrings.
 *
 * The right matcher for Bangla, which is agglutinative: "ত্বকে" and
 * "ত্বকের" both contain "ত্বক", and a whole-token match would miss
 * every inflected form of every word.
 */
function containsAnySubstring(
  text: string,
  phrases: readonly string[],
): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

/**
 * Whether the message is a greeting and nothing else.
 *
 * ── How this works ────────────────────────────────────────────────────────
 *
 * The message is stripped of greeting words and conversational filler
 * ("how are you", "good morning"). If **nothing** is left, the customer
 * was greeting — that is the whole message.
 *
 * This is what makes "hi" a greeting and "hi, my pores are huge" not
 * one. The second message has content the greeting words do not
 * account for, so it falls through to the concern check.
 *
 * The empty result is deliberate. A customer who sends a photo with no
 * text has said nothing, and asking them about their skin is the right
 * response — unless a photo is attached, which is handled by the caller.
 */
function isGreeting(text: string): boolean {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return true;
  }

  const words = tokens(text);

  // An empty message after normalisation is a greeting too.
  if (words.length === 0) {
    return true;
  }

  /*
   * The Bangla script.
   *
   * A Bengali greeting is matched as a whole phrase, because the
   * greeting words combine: "শুভ সকাল" is one greeting made of two
   * words, and neither half is a greeting on its own in the same way.
   *
   * The check is that the message is *made of* greeting words — every
   * word has to be one — so "হ্যালো আমার ত্বকে ব্রণ হয়" is not a
   * greeting.
   */
  if (/[\u0980-\u09FF]/.test(trimmed)) {
    return words.every((word) => BENGALI_GREETINGS.has(word));
  }

  /*
   * The English script.
   *
   * The message is stripped of greeting words and conversational
   * filler ("how are you", "good morning"). If **nothing** is left,
   * the customer was greeting — that is the whole message.
   *
   * This is what makes "hi" a greeting and "hi, my pores are huge" not
   * one. The second message has content the greeting words do not
   * account for, so it falls through to the concern check.
   */
  const remaining = words.filter((word) => !GREETING_FILLER.has(word));

  // Everything was filler: the message was "hi how are you good morning".
  return remaining.length === 0;
}

/**
 * Works out what the advisor still needs to know.
 *
 * The profile is consulted first. A customer who has already set their
 * skin type does not need to be asked for it again — asking is the
 * single most annoying thing a chat advisor can do.
 */
function missingDetails(context: AdvisorIntentContext): MissingDetail[] {
  const missing: MissingDetail[] = [];

  const hasSkinType =
    typeof context.skinType === "string" && context.skinType.trim().length > 0;

  if (!hasSkinType) {
    missing.push("SKIN_TYPE");
  }

  const hasConcerns =
    Array.isArray(context.concerns) && context.concerns.length > 0;

  if (!hasConcerns) {
    missing.push("CONCERNS");
  }

  return missing;
}

/**
 * Detects the intent of a turn.
 *
 * @param userMessage - What the customer just typed.
 * @param context - What else code knows about this turn.
 *
 * @returns What code has decided this turn is.
 */
export function detectAdvisorIntent(
  userMessage: string,
  context: AdvisorIntentContext = {},
): AdvisorIntent {
  const normalised = normalise(userMessage);

  const hasImage = context.hasImage === true;

  /*
   * A photo is a concern in its own right.
   *
   * A customer who attaches a picture of their face and says "hi" is
   * asking for the picture to be looked at. Treating that as a greeting
   * — and therefore telling them to describe their skin instead — would
   * be exactly backwards.
   */
  if (hasImage) {
    return concernIntent(missingDetails(context));
  }

  /*
   * The order of the checks below matters, and it is the order of how
   * specific each signal is.
   *
   * 1. **Greeting.** The most specific, and the one with the strictest
   *    shape — a message that is *only* a greeting.
   *
   * 2. **Concern.** The customer described their skin. This is checked
   *    before the question check because a message can be both ("why is
   *    my skin so oily?") and the *concern* is the more useful fact:
   *    it tells the advisor what the advice should be about.
   *
   * 3. **Order.** A question about the shop. It is checked after the
   *    concern check so that "I want to order a serum for my oily skin"
   *    is still treated as a concern — the customer described their
   *    skin, and that is what the advice should be about.
   *
   * 4. **Question.** Everything else that looks like a question.
   */
  if (isGreeting(normalised)) {
    return { ...GREETING_INTENT, missing: missingDetails(context) };
  }

  const banglaScript = /[\u0980-\u09FF]/.test(normalised);

  const mentionsConcern = banglaScript
    ? containsAnySubstring(normalised, BENGALI_CONCERN_KEYWORDS)
    : containsAny(normalised, CONCERN_KEYWORDS);

  const asksQuestion = banglaScript
    ? containsAnySubstring(normalised, BENGALI_QUESTION_KEYWORDS)
    : containsAny(normalised, QUESTION_KEYWORDS);

  /*
   * Whether the customer is asking about combining products.
   *
   * Computed before the branches because it decides the `mayWarn` flag on
   * the question turn, and the question branch is the one that needs it.
   *
   * Two ways to qualify:
   *
   *   • The message names the act of combining outright — "layer",
   *     "combine", "together". Those words only appear when the customer
   *     is talking about using things together, so they are enough on
   *     their own.
   *
   *   • The message links two things with a preposition — "with my",
   *     "with the", "both". Those need a product word alongside them,
   *     because on their own they are ordinary English: "I am with my
   *     family" is not a question about a routine.
   */
  const namesCombinationAct = containsAnySubstring(
    normalised,
    ROUTINE_COMBINATION_KEYWORDS,
  );

  const linksTwoThings =
    containsAnySubstring(normalised, ROUTINE_LINKING_PREPOSITIONS) &&
    containsAnySubstring(normalised, ROUTINE_PRODUCT_WORDS);

  const asksAboutCombining = namesCombinationAct || linksTwoThings;

  if (mentionsConcern) {
    return concernIntent(missingDetails(context));
  }

  if (isOrderQuestion(normalised)) {
    return orderIntent();
  }

  if (asksQuestion) {
    /*
     * A question may warn, but only when the question is *about the
     * routine* — when combining products is what the customer is asking.
     *
     * "can I use this with my sunscreen?" is asking whether two things
     * go together, and the conflict engine's answer is the answer. But
     * "how do I use retinol?" is asking how to use a product, and
     * answering it with an amber "use with care" panel about a pair they
     * never mentioned is the advisor trying to sell a problem.
     */
    return questionIntent(missingDetails(context), asksAboutCombining);
  }

  /*
   * Nothing recognisable.
   *
   * This is the "I typed something and I am waiting" case. The advisor
   * treats it as a question — it answers as best it can and asks what it
   * still needs to know. It does **not** recommend, because nothing in
   * the message said what the advice should be about, and a routine
   * built on nothing is the exact behaviour this module exists to stop.
   *
   * It also does not warn. An unrecognised message is the "casual or
   * other" case — a thank-you, a stray emoji, a sentence about the
   * weather — and the right reply to that is a warm, plain answer, not
   * an ingredient-conflict panel.
   */
  return questionIntent(missingDetails(context), asksAboutCombining);
}

/**
 * Whether the message is about the order rather than the skin.
 */
function isOrderQuestion(text: string): boolean {
  return containsAny(text, ORDER_KEYWORDS);
}

/**
 * Describes the intent for the prompt.
 *
 * The prompt needs the intent spelled out, because a model told only
 * "be conversational" will still drift towards a product list — a
 * product list is what "helpful" looks like to a model asked about
 * skincare. Told explicitly that this turn is a greeting, it behaves.
 *
 * ── Why it says "recommend nothing" and not "set an empty array" ─────────
 *
 * It used to say *"Set recommendedProductIds to an empty array"*,
 * because the model was answering in JSON. It is not any more — the
 * advisor speaks in plain prose, and there is no array to set. The
 * instruction is now the same one a person would follow: recommend
 * nothing. The rule is enforced in code regardless (see
 * `selectRecommendedIds` in `src/lib/ai/service.ts`), but the prompt
 * and the code now speak the same language.
 */
export function describeAdvisorIntent(intent: AdvisorIntent): string {
  /*
   * The conflict rule.
   *
   * ── Why it is a separate line, and not part of the kind's text ─────────
   *
   * Whether a turn may warn about ingredient conflicts is **not** a
   * property of the turn's kind alone. A concern turn always may; a
   * question turn may only when the question is about combining
   * products; a greeting and an order question never may.
   *
   * So the instruction is derived from `mayWarn` rather than from
   * `kind`, and the two must agree — a prompt that told the model to
   * warn about a conflict the code then suppressed would put the warning
   * in the **prose** instead of the card, which is the same defect in a
   * different font.
   *
   * The instruction is appended to every kind rather than woven into
   * each one, so that the rule is stated exactly once and cannot drift
   * out of step with `mayWarn`.
   */
  const conflictRule = intent.mayWarn
    ? "You may mention an ingredient conflict if it is genuinely relevant to what the customer asked — the conflict list is in your brief."
    : "Do NOT mention any ingredient conflict, any conflict with what they already own, or any warning about combining products on this turn. The customer did not ask about their routine, and an unsolicited conflict warning is noise.";

  switch (intent.kind) {
    case "GREETING":
      return [
        "THIS TURN IS A GREETING. The customer has only said hello — they have not described their skin yet.",
        "Greet them back warmly, in one or two sentences. Do NOT list any product, and do NOT describe a routine. Do NOT mention a price.",
        "Ask them what their skin type is (oily, dry, combination, sensitive, acne-prone) and what they are struggling with (acne, dark spots, dullness, large pores, dryness, sensitivity).",
        "Recommend nothing on this turn — and report that you recommended nothing.",
        conflictRule,
      ].join(" ");

    case "CONCERN":
      return [
        "THIS TURN IS A CONCERN. The customer has described their skin or their goal, so advice is wanted.",
        "Answer their concern directly and conversationally, in two or three short paragraphs — a real reply, not a catalogue.",
        "Then, and only then, mention the products that actually match what they described. Recommend at most three, each with one line of why it suits them.",
        "If the customer has not yet said their skin type, ask for it at the end.",
        conflictRule,
      ].join(" ");

    case "QUESTION":
      return [
        "THIS TURN IS A QUESTION. The customer asked something specific — answer that question first.",
        "Be concise and conversational. Do not launch into a full routine unless the question actually called for one.",
        "Mention a product only when it is the direct answer to what they asked. If they are asking about something the catalogue does not carry, say so plainly and suggest what to look for instead.",
        "If the conversation still has no skin type or concern, ask for one at the end.",
        conflictRule,
      ].join(" ");

    case "ORDER":
      return [
        "THIS TURN IS AN ORDER QUESTION — this turn is about the shop, not about skincare. The customer asked about delivery, payment, an order or a coupon.",
        "Answer the question directly and briefly. Do NOT list any product, and do NOT describe a routine.",
        "Recommend nothing on this turn — and report that you recommended nothing.",
        conflictRule,
      ].join(" ");
  }
}
