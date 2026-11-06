/**
 * The advisor's language detection.
 *
 * ── Why this is a module of its own ───────────────────────────────────────
 *
 * The advisor is used in Dhaka, and a customer who types in Bengali must
 * not be answered in English. The model can do that on its own — it is
 * good at it — but only if it is *told* what language the customer used.
 * A model does not reliably infer this from the instruction alone, and
 * a Banglish message ("amar skin er problem ache") looks like English
 * to a naive check.
 *
 * So the detection is done **in code**, where it is deterministic and
 * testable, and the result is handed to the provider as a fact rather
 * than left to the model to guess.
 *
 * ── The two cases that matter ─────────────────────────────────────────────
 *
 * **1. Bengali script.** Any character in the Bengali Unicode block
 * means the customer wrote in Bengali. This is unambiguous, so it is
 * checked first and it wins outright.
 *
 * **2. Banglish.** Bengali written in the Latin script. This is how a
 * large share of Bangladeshi users actually type — "amar skin er
 * problem ache, kivabe use korbo?" — and it is *not* English, even
 * though every word is a Latin word.
 *
 * The detection for Banglish is a **vocabulary** match rather than a
 * character check, because there is no script to key off. It counts
 * Bangla words written in Latin script and compares that count against
 * the length of the message.
 *
 * ── Why a vocabulary and not a model ──────────────────────────────────────
 *
 * A probabilistic language classifier would be a dependency, a network
 * call or a model download, for a decision that a list of words makes
 * perfectly well. And the failure mode matters: a false positive sends
 * an English question to a model told to answer in Bengali, and the
 * customer gets an answer in a language they did not use. So the
 * vocabulary is deliberately **specific** — words that are Bangla in
 * Roman script and essentially never English in a skincare message.
 *
 * That specificity is why the list below deliberately omits words like
 * "pore" (an English skincare term *and* a Bangla word), and includes
 * only the longer, unambiguous forms such as "porer".
 */

/**
 * The detected language.
 */
export type AdvisorLanguage = {
  /**
   * The language the answer should be written in.
   *
   * `"bn"` for both Bengali script and Banglish — the model's prompt
   * asks for fluent Bengali in either case, and Banglish written as
   * Latin script would be an odd thing to reply in.
   */
  readonly code: "bn" | "en";
  /**
   * True when the customer wrote Banglish — Bengali in Latin script.
   *
   * Only meaningful when `code` is `"bn"`. It lets the prompt be
   * precise about what it is answering, which matters because a
   * Banglish message often contains English product names that should
   * stay in English.
   */
  readonly isBanglish: boolean;
};

/**
 * English.
 */
export const ENGLISH: AdvisorLanguage = { code: "en", isBanglish: false };

/**
 * Bengali, written in the Bangla script.
 */
export const BENGALI: AdvisorLanguage = { code: "bn", isBanglish: false };

/**
 * Bengali, written in Latin script (Banglish).
 */
export const BANGLISH: AdvisorLanguage = { code: "bn", isBanglish: true };

/**
 * The Bengali Unicode block.
 *
 * U+0980 to U+09FF covers the Bangla letters, the dependent vowel
 * signs and the Bengali digits. A single character from this block is
 * enough to say the customer wrote in Bengali.
 */
const BENGALI_SCRIPT = /[\u0980-\u09FF]/;

/**
 * The Banglish vocabulary.
 *
 * ── How this list was chosen ─────────────────────────────────────────────
 *
 * Every entry is a word that is ordinary Bangla in Roman script and
 * **rare in an English skincare message**. The test each entry has to
 * pass is: *"would a customer writing an English message about acne
 * and sunscreen plausibly type this?"*
 *
 * That is why several obvious candidates are absent:
 *
 *   • `pore` — an English skincare term ("large pores") *and* a Bangla
 *     word ("after"). It would misfire constantly.
 *   • `use`, `na`, `ta`, `te` — far too common in ordinary English.
 *   • `face`, `skin`, `acne`, `serum` — the vocabulary of this shop's
 *     own catalogue, and therefore likely to appear in English too.
 *
 * The longer forms are preferred throughout ("porer" rather than
 * "pore", "korechi" rather than "kore") for exactly this reason: the
 * inflection carries the signal that the bare stem does not.
 */
const BANGLISH_VOCABULARY = new Set([
  // Pronouns and possessives.
  "amar",
  "amader",
  "apnar",
  "amake",
  "apaka",

  // Verbs.
  "ache",
  "achi",
  "achilo",
  "hocche",
  "hocchilo",
  "hobo",
  "hobe",
  "hobechilo",
  "kore",
  "kora",
  "korle",
  "korbo",
  "korechi",
  "korechilam",
  "kaj",
  "niye",
  "niyam",
  "debo",
  "nilam",
  "bole",
  "bolo",
  "bujhte",
  "parchi",
  "parbe",

  // Question words.
  "keno",
  "kivabe",
  "kemon",
  "kivabeno",

  // Nouns.
  "problem",
  "protita",
  "jinish",
  "gulo",
  "onek",
  "ekta",
  "ekhon",
  "ekhonki",
  "shokal",
  "sokal",
  "rate",
  "din",
  "porer",
  "shokal",
  "mone",
  "taka",

  // Adjectives and adverbs.
  "valo",
  "bhalo",
  "kharap",
  "darun",
  "thik",
  "lagche",
  "lagse",
  "lagbe",
  "lagtesilo",
  "niyom",

  // Common fillers.
  "vai",
  "thaka",
  "hote",
  "hoteche",
]);

/**
 * The minimum number of Banglish words for a message to count as
 * Banglish.
 *
 * One word is not enough — "no" and "na" and "hot" style near-misses
 * turn up in English messages often enough that a single hit would
 * misfire regularly.
 */
const MIN_BANGLISH_MATCHES = 2;

/**
 * The fraction of the message that must be Banglish.
 *
 * A customer writing a long English message that happens to contain
 * two Bangla words is writing English. A customer writing a short
 * message that is mostly Bangla words is writing Banglish.
 *
 * The threshold is low because the vocabulary is already specific —
 * the two filters together are much stricter than either alone.
 */
const MIN_BANGLISH_RATIO = 0.12;

/**
 * Splits a message into lowercase word tokens.
 *
 * The tokenizer keeps only letters, so punctuation and digits are
 * dropped: "ache." and "ache," and "ache!" are all the same word, and
 * "8pm" contributes nothing.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length > 0);
}

/**
 * Detects the language a customer wrote in.
 *
 * @param text - The customer's message.
 *
 * @returns The language to answer in, and whether it was Banglish.
 */
export function detectAdvisorLanguage(text: string): AdvisorLanguage {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return ENGLISH;
  }

  /*
   * The Bangla script wins outright.
   *
   * A single Bangla character settles it — there is no mixed-script
   * ambiguity to resolve, because a message containing Bangla script
   * is a message written in Bengali.
   */
  if (BENGALI_SCRIPT.test(trimmed)) {
    return BENGALI;
  }

  const tokens = tokenize(trimmed);

  if (tokens.length === 0) {
    return ENGLISH;
  }

  let matches = 0;

  for (const token of tokens) {
    if (BANGLISH_VOCABULARY.has(token)) {
      matches += 1;
    }
  }

  if (matches < MIN_BANGLISH_MATCHES) {
    return ENGLISH;
  }

  if (matches / tokens.length < MIN_BANGLISH_RATIO) {
    return ENGLISH;
  }

  return BANGLISH;
}

/**
 * Describes the detected language for the prompt.
 *
 * The prompt needs the distinction between the two Bengali cases,
 * because a Banglish message is full of English product names and
 * ingredient names that should be left in English rather than
 * translated.
 */
export function describeAdvisorLanguage(language: AdvisorLanguage): string {
  if (language.code === "en") {
    return "The customer wrote in English. Reply in English.";
  }

  if (language.isBanglish) {
    return "The customer wrote in Banglish (Bengali in Latin script). Reply in fluent, polite, clear Bengali. Keep product names and ingredient names in their original English.";
  }

  return "The customer wrote in Bengali (Bangla script). Reply in fluent, polite, clear Bengali. Keep product names and ingredient names in their original English.";
}
