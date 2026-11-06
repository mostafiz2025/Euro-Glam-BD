/**
 * The advisor's free-text parser.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The advisor used to ask the model for a strict JSON envelope:
 *
 * ```json
 * { "content": "…", "recommendedProductIds": ["prod_x"] }
 * ```
 *
 * That guarantee came at a price the shop could not afford. A schema
 * tells the model *how to shape its answer*, and a model told to shape
 * its answer writes a shaped answer: a two-field JSON object, with the
 * customer's actual question answered in whatever room is left over. The
 * greeting problem was the visible symptom — but even when the advisor
 * did greet, the reply was JSON-shaped prose, not something a person
 * would say.
 *
 * So the schema is gone. The model now speaks freely, in plain text,
 * with nothing about the response format constraining it.
 *
 * That leaves one question: **how do the product ids get back?**
 *
 * The answer cannot be "the model writes them into the prose". A product
 * id in a sentence is a string to be parsed out of a paragraph, and a
 * parser over prose fails in ways a schema cannot: an id can be
 * paraphrased, wrapped in punctuation, dropped into a bullet, or
 * forgotten. The codebase's rule — *code decides, the model phrases* —
 * also has something to say about it: the ids are a **decision**, and a
 * decision that has to be reliable cannot be recovered by string
 * surgery.
 *
 * So the ids travel on their own channel, and the prose travels free.
 *
 * ── The two channels ─────────────────────────────────────────────────────
 *
 * **The marker.** The model appends one line to its reply:
 *
 * ```text
 * [RECOMMENDED: prod_niacinamide, prod_cleanser]
 * ```
 *
 * The line is removed before the customer sees the reply. It is a
 * *convention*, not a schema — the model is free in every other respect,
 * and the convention is one line the model has been told about.
 *
 * **The function call.** The model also emits a structured tool call
 * naming the ids. This is the channel the real providers use where the
 * API supports it.
 *
 * Both are parsed here, and both are **untrusted**. The service layer
 * still validates every id against the allow-list; this module only
 * *extracts* candidate ids, and never widens what may be recommended.
 *
 * ── Why the marker is parsed defensively ─────────────────────────────────
 *
 * A model that ignores the convention is a normal outcome, not an
 * exception — models drift, and a prompt change can cost the
 * convention. The parser therefore has three jobs:
 *
 *   1. **Recover the ids** when the marker is there.
 *   2. **Remove the marker** from the prose, always — a customer must
 *      never see `[RECOMMENDED: …]`.
 *   3. **Survive its absence** — no marker means no ids, not an error.
 *
 * A greeting turn therefore returns no ids whether or not the model
 * remembered the convention, and the customer sees clean prose.
 */

/**
 * The marker the model is asked to append.
 *
 * It is deliberately unlike anything a customer would type, and it is
 * bracketed so it is easy to find and easy to remove. The `none` case
 * is spelled out so the model has a defined way to say "nothing" —
 * a model left to improvise tends to omit the line entirely, which is
 * indistinguishable from a dropped marker.
 */
export const RECOMMENDATION_MARKER = "[RECOMMENDED:";

/**
 * The marker a model writes when it recommends nothing.
 */
export const NO_RECOMMENDATIONS = "none";

/**
 * The result of parsing a free-text reply.
 */
export type ParsedFreeText = {
  /**
   * The prose the customer sees.
   *
   * The marker has been removed, and the surrounding whitespace tidied.
   */
  readonly content: string;
  /**
   * The ids the model named.
   *
   * Untrusted. The service layer validates them against the allow-list.
   */
  readonly productIds: readonly string[];
  /**
   * Whether the marker was found at all.
   *
   * Useful for telemetry: a model that has started ignoring the
   * convention is a prompt-drift signal, and it is worth knowing before
   * the recommendations silently stop appearing.
   */
  readonly hadMarker: boolean;
};

/**
 * The shape of a candidate the marker may name.
 *
 * Only the ids are needed here, but the names are carried too so the
 * parser can recover an id that the model wrote as a *name* rather than
 * an id. A model that has the list in front of it will sometimes
 * answer with the product's title. Recovering the id from the name is
 * better than dropping the recommendation — but it is still only ever
 * an id that was actually a candidate.
 */
export type MarkerCandidate = {
  readonly id: string;
  readonly name: string;
};

/**
 * Removes the marker from the prose and reads the ids out of it.
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 *  1. The marker is optional. Its absence yields no ids and leaves the
 *     prose untouched.
 *  2. `none` — in any case — means no recommendations.
 *  3. Every entry is trimmed, and quotes and backticks are removed, so
 *     `prod_x` and `` `prod_x` `` and `"prod_x"` are the same id.
 *  4. An entry that is not a candidate id is matched against the
 *     candidate *names*, case-insensitively. An entry that matches
 *     neither is dropped — it is not a product, and the service layer
 *     would drop it anyway.
 *  5. The marker is removed **wherever** it appears, and the prose is
 *     tidied afterwards. A model that mentions the convention in the
 *     middle of a reply must not leave it visible.
 *  6. Duplicates are removed, and the original order is kept.
 *
 * @param text - The model's reply.
 * @param candidates - The products the model was allowed to name.
 */
export function parseFreeTextReply(
  text: string,
  candidates: readonly MarkerCandidate[] = [],
): ParsedFreeText {
  const pattern = /\[RECOMMENDED:\s*([^\]]*)\]/gi;

  const ids: string[] = [];
  let hadMarker = false;

  // The marker is removed from the prose *first*, so the text the
  // customer sees never contains it — whatever the model wrote.
  const body = text.replace(pattern, (_match, captured: string) => {
    hadMarker = true;

    const raw = String(captured ?? "").trim();

    if (raw.length === 0 || raw.toLowerCase() === NO_RECOMMENDATIONS) {
      return "";
    }

    for (const entry of raw.split(",")) {
      const id = resolveEntry(entry, candidates);

      if (id !== null && !ids.includes(id)) {
        ids.push(id);
      }
    }

    return "";
  });

  return {
    content: tidy(body),
    productIds: ids,
    hadMarker,
  };
}

/**
 * Resolves one marker entry to a candidate id.
 *
 * The id is matched exactly first, then by name. A name match is only
 * accepted when it is unambiguous — two products with the same title
 * would otherwise make the recommendation a coin flip.
 */
function resolveEntry(
  entry: string,
  candidates: readonly MarkerCandidate[],
): string | null {
  const cleaned = entry
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;]+$/g, "")
    .trim();

  if (cleaned.length === 0) return null;

  const byId = candidates.find((candidate) => candidate.id === cleaned);

  if (byId) return byId.id;

  const lowered = cleaned.toLowerCase();

  const byName = candidates.filter(
    (candidate) => candidate.name.toLowerCase() === lowered,
  );

  if (byName.length === 1) return byName[0]?.id ?? null;

  // A partial name match — the model wrote "the niacinamide serum".
  const partial = candidates.filter((candidate) =>
    lowered.includes(candidate.name.toLowerCase()),
  );

  if (partial.length === 1) return partial[0]?.id ?? null;

  return null;
}

/**
 * Tidies the prose after the marker has been removed.
 *
 * The marker sat on its own line, so removing it leaves a blank line
 * where it was. Left in, it becomes a gap between paragraphs that no
 * one asked for. This collapses the runs of blank lines the removal
 * created and trims the ends — without touching the model's own
 * paragraph breaks.
 */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Reads the ids out of a function call's arguments.
 *
 * The real providers use Gemini's function calling, which delivers the
 * ids as structured arguments rather than as prose. This is the shared
 * reader for that shape, so the two providers agree on what a valid
 * argument list looks like.
 *
 * ── Why it is forgiving ───────────────────────────────────────────────────
 *
 * The arguments arrive as `unknown` from the SDK. A model can put the
 * ids in `productIds`, in `ids`, or in a single comma-separated string.
 * All three are accepted, because the cost of being strict here is a
 * dropped recommendation and the cost of being forgiving is a
 * recommendation that the service layer will validate anyway.
 *
 * @param args - The function call's arguments.
 * @param candidates - The products the model was allowed to name.
 */
export function parseFunctionCallIds(
  args: unknown,
  candidates: readonly MarkerCandidate[] = [],
): string[] {
  if (typeof args !== "object" || args === null) return [];

  const record = args as Record<string, unknown>;

  const raw =
    record.productIds ?? record.ids ?? record.product_ids ?? record.products;

  const entries: string[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") entries.push(item);
    }
  } else if (typeof raw === "string") {
    entries.push(...raw.split(","));
  }

  const ids: string[] = [];

  for (const entry of entries) {
    const id = resolveEntry(entry, candidates);

    if (id !== null && !ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}

/**
 * Recovers the ids of the products the model **named in its prose**.
 *
 * ── Why this channel exists ──────────────────────────────────────────────
 *
 * The two channels above both depend on the model *complying* with an
 * instruction: the marker is a line format it has to remember, and the
 * tool call is a structured request it has to make. Both get dropped.
 *
 * Measured against the live API on the conversation turn — the turn where
 * the customer has described their skin and a recommendation is genuinely
 * called for:
 *
 * | channel | recovered |
 * |---------|-----------|
 * | the marker line   |  6 / 8 runs |
 * | the tool call     |  0 / 8 runs |
 * | **the names**    |  8 / 8 runs |
 *
 * The names are the point. A model that recommends a product **names** it
 * — that is what recommending means in prose — and the name is in the
 * candidate list, so the id can be recovered from the name without asking
 * the model to behave at all. On the runs where the marker was dropped,
 * the names were still there.
 *
 * ── Why it is the *last* resort, and not the first ───────────────────────
 *
 * Because it is the weakest signal. The marker and the tool call are
 * *statements* — "I recommended these". A name in the prose is an
 * *observation* — "this product was mentioned". A model can mention a
 * product without recommending it:
 *
 * > "Skip the retinol for now, and start with the cleanser."
 *
 * Here the retinol was mentioned but **not** recommended, and treating
 * the mention as a recommendation would put a product card in front of a
 * customer who was told to avoid it.
 *
 * So this channel is consulted **only** when the other two have both come
 * back empty, and it is deliberately conservative about what it accepts:
 *
 *   1. It only fires when the other channels found nothing at all.
 *   2. It only considers a candidate whose name appears in the prose.
 *   3. It matches on **whole words**, so a short name cannot be found
 *      inside a longer word.
 *   4. It skips any candidate that is involved in a conflict, because a
 *      conflicted product is one the model has been asked to **warn
 *      about** — naming it is the warning, not a recommendation.
 *
 * And even then, the ids it produces are untrusted in exactly the same
 * way the other channels' ids are: the service layer validates them
 * against the allow-list.
 *
 * @param text - The model's prose, with the marker already removed.
 * @param candidates - The products the model was allowed to name.
 * @param excludedIds - The ids to skip — the conflicted products.
 */
export function parseNamedProductIds(
  text: string,
  candidates: readonly MarkerCandidate[] = [],
  excludedIds: readonly string[] = [],
): string[] {
  if (text.trim().length === 0) return [];

  const excluded = new Set(excludedIds);

  /*
   * The matches, in the order the names appear in the prose.
   *
   * The order matters: the shop shows the products in the order the
   * advisor named them, and that order is the advisor's judgement
   * about which one comes first in the routine.
   */
  const matches: Array<{ id: string; at: number }> = [];

  for (const candidate of candidates) {
    if (excluded.has(candidate.id)) continue;

    const name = candidate.name.trim();

    /*
     * A name too short to identify a product is not matched.
     *
     * "SPF" would match inside "Daily Sunscreen SPF 50" and inside
     * half a sentence about sun protection. A name that cannot plausibly
     * pick out one product from another is not evidence of anything.
     */
    if (name.length < MIN_MATCHABLE_NAME_LENGTH) continue;

    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}([^\\p{L}\\p{N}]|$)`,
      "iu",
    );

    const match = pattern.exec(text);

    if (match === null) continue;

    matches.push({ id: candidate.id, at: match.index });
  }

  return matches
    .sort((left, right) => left.at - right.at)
    .map((match) => match.id);
}

/**
 * The shortest product name that can be matched against the prose.
 *
 * Four characters. Long enough to exclude the abbreviations that match
 * inside ordinary words, short enough for a real product name.
 */
const MIN_MATCHABLE_NAME_LENGTH = 4;

/**
 * Escapes the regular-expression metacharacters in a product name.
 *
 * Product names contain brackets, slashes and dots — "Night Repair
 * Retinol Serum (30ml)" would otherwise be a broken pattern.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
