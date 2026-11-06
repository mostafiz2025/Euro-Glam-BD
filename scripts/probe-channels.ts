import "dotenv/config";

import { OpenRouterProvider } from "@/lib/ai/openrouter-provider";
import { detectAdvisorIntent } from "@/lib/ai/intent";
import { BENGALI } from "@/lib/ai/language";
import type { AdvisorRequest } from "@/lib/ai/provider";

/**
 * A diagnostic: which channel is actually carrying the product ids?
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The advisor gets the product ids back on three channels:
 *
 *   1. a **tool call** — the model called `recommend_products` and the
 *      ids are its structured arguments;
 *   2. the **marker line** — `[RECOMMENDED: …]` at the end of the prose;
 *   3. the **names in the prose** — the model named the products it put
 *      in front of the customer.
 *
 * The first two are statements the model has to *make*. The third is
 * only an observation. A live run showed the marker being dropped often
 * enough to cost the shop its product cards, which is what sent the
 * search for a more reliable channel.
 *
 * This script measures all three, **through the real provider**, so what
 * it reports is what the shop would actually get — not what a
 * hand-rolled request would produce.
 *
 * ── What to do with the numbers ──────────────────────────────────────────
 *
 * If the tool call or the marker recovery rate falls, the corresponding
 * prompt instruction has drifted and the channel is being lost. If the
 * name recovery rate falls, the model has started describing products
 * instead of naming them.
 *
 * Run it with:
 *
 *   npx tsx scripts/probe-channels.ts [runs]
 *
 * It needs `OPENROUTER_API_KEY` in the environment. It does not write to
 * the database, and it does not touch the storefront.
 */

const CANDIDATE = {
  id: "prod_niacinamide",
  name: "Niacinamide 10% Serum",
  categoryName: "Serums",
  pricePaisa: 120000,
  discountPricePaisa: null,
  ingredientTags: ["NIACINAMIDE"],
  climateTips: null,
  description: "A balancing serum for oily skin.",
};

const SECOND_CANDIDATE = {
  id: "prod_cleanser",
  name: "Gentle Gel Cleanser",
  categoryName: "Cleansers",
  pricePaisa: 90000,
  discountPricePaisa: null,
  ingredientTags: ["GLYCERIN"],
  climateTips: null,
  description: "A pH-balanced daily cleanser.",
};

/**
 * The request the provider receives.
 */
function makeRequest(
  userMessage: string,
  history: AdvisorRequest["history"] = [],
): AdvisorRequest {
  return {
    userMessage,
    profile: { skinType: null, concerns: [], notes: null },
    candidates: [CANDIDATE, SECOND_CANDIDATE],
    conflicts: [],
    allowedProductIds: [CANDIDATE.id, SECOND_CANDIDATE.id],
    systemPrompt: null,
    history,
    language: BENGALI,
    intent: detectAdvisorIntent(userMessage, {
      hasImage: false,
      skinType: null,
      concerns: [],
    }),
  };
}

/**
 * The conversation the concern turn happens in.
 *
 * The marker was dropped on the **conversation** turn — the one where the
 * customer has already been greeted and has described their skin — so
 * that is the turn worth measuring.
 */
const HISTORY: AdvisorRequest["history"] = [
  { role: "USER", content: "Hi" },
  {
    role: "ASSISTANT",
    content: "হ্যালো! আপনার ত্বক নিয়ে কী জানতে চান?",
  },
];

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    console.error(
      "OPENROUTER_API_KEY is not set. Add it to .env and try again.",
    );
    process.exitCode = 1;
    return;
  }

  const runs = Number(process.argv[2] ?? 8);

  const provider = new OpenRouterProvider({ apiKey });

  console.log(`Provider : ${provider.name}`);
  console.log(`Model    : ${provider.modelName}`);
  console.log("═".repeat(60));

  const question = "আমার ত্বকে অনেক ব্রণ হয়, তেলতেলে। কী ব্যবহার করবো?";

  let withProse = 0;
  let withIds = 0;

  for (let run = 0; run < runs; run += 1) {
    const response = await provider.complete(
      makeRequest(question, HISTORY),
    );

    const ids = response.recommendedProductIds;

    if (response.content.trim().length > 0) withProse += 1;
    if (ids.length > 0) withIds += 1;

    /*
     * A cross-provider check, on the live API: the ids the provider
     * returned are the ids the shop would attach.
     */
    console.log(
      `  run ${run + 1}: prose ${String(response.content.length).padStart(4)}  ids ${ids.length === 0 ? "(none)" : ids.join(", ")}`,
    );
  }

  console.log("─".repeat(60));
  console.log(
    `prose ${withProse}/${runs}   ids recovered ${withIds}/${runs}`,
  );

  if (withIds < runs) {
    console.log(
      "\nSome turns lost their ids. Run `probe-endpoints.ts` to check the\nmodel's tool support, and `probe-tools.ts` to check that it emits\ntool calls at all.",
    );
  }
}

main().catch((error: unknown) => {
  console.error("The probe failed:", error);
  process.exitCode = 1;
});
