import "dotenv/config";

import { GeminiProvider } from "@/lib/ai/gemini-provider";
import { RECOMMENDATION_MARKER } from "@/lib/ai/free-text";
import { detectAdvisorIntent } from "@/lib/ai/intent";
import { BENGALI } from "@/lib/ai/language";
import type { AdvisorRequest } from "@/lib/ai/provider";

/**
 * A live smoke test for the advisor's **conversational** behaviour.
 *
 * ── What it proves ───────────────────────────────────────────────────────
 *
 * The unit tests inject a stubbed SDK client, so they prove the request
 * *shape* — that the turn instruction reaches the model. They cannot
 * prove that Google obeys it. This script makes real calls and checks
 * the three things the customer actually sees:
 *
 *   1. **"Hi" gets a greeting, not a routine.** No product ids, and no
 *      price in the answer.
 *   2. **A described concern gets advice.** The product is recommended,
 *      because the conversation has earned it.
 *   3. **A follow-up question is answered conversationally.** It reads
 *      like a reply, not a catalogue.
 *
 * The third check is the one that cannot be asserted by the others: a
 * model that has been given a candidate list and no turn instruction
 * will list the products. Whether the turn instruction actually
 * changes that is a question only a live model can answer.
 *
 * ── What the free-text refactor changed ───────────────────────────────────
 *
 * The provider no longer asks for JSON. The reply is prose, and the
 * product ids travel on a side channel — a marker line the model
 * appends, and a function call it emits. So this script also checks
 * the two properties that refactor has to hold on a **live** model:
 *
 *   • the marker never reaches the customer, and
 *   • the reply is prose rather than a JSON envelope.
 *
 * The second one matters because a model that has been asked for JSON
 * will happily oblige, and a customer who sees `{"content": …}` has
 * been given a bug, not an answer.
 *
 * Run it with:
 *
 *   npx tsx scripts/verify-conversation.ts
 *
 * It needs `GEMINI_API_KEY` in the environment. It does not write to the
 * database, and it does not touch the storefront.
 *
 * Note that the Gemini free tier allows a limited number of requests
 * per day, and this script makes three.
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
 * Builds a request for a turn, with the intent code decided — exactly
 * as the service layer does it.
 */
function makeRequest(
  userMessage: string,
  history: AdvisorRequest["history"] = [],
): AdvisorRequest {
  return {
    userMessage,
    profile: {
      skinType: null,
      concerns: [],
      notes: null,
    },
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

let failures = 0;

/**
 * Prints a check result.
 */
function check(label: string, passed: boolean, detail = ""): void {
  if (passed) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set. Add it to .env and try again.");
    process.exitCode = 1;
    return;
  }

  const provider = new GeminiProvider({ apiKey });

  console.log(`Provider : ${provider.name}`);
  console.log(`Model    : ${provider.modelName}`);
  console.log("═".repeat(60));

  // ── 1. The greeting turn ──────────────────────────────────────────────
  console.log("\n1. A customer says \"Hi\"");
  console.log("─".repeat(60));

  const greeting = await provider.complete(makeRequest("Hi"));
  const greetingIntent = detectAdvisorIntent("Hi");

  console.log(greeting.content);
  console.log("─".repeat(60));

  check(
    "the turn is classified as a greeting",
    greetingIntent.kind === "GREETING",
    greetingIntent.kind,
  );

  check(
    "no product was recommended",
    greeting.recommendedProductIds.length === 0,
    greeting.recommendedProductIds.join(", ") || "(none)",
  );

  check(
    "no price appears in the answer",
    !greeting.content.includes("৳"),
  );

  check(
    "the answer asks about the skin",
    /skin|ত্বক|স্কিন/i.test(greeting.content),
  );

  check(
    "the marker line never reaches the customer",
    !greeting.content.includes(RECOMMENDATION_MARKER),
  );

  check(
    "the answer is prose, not a JSON envelope",
    !/^\s*[{[]/.test(greeting.content),
    greeting.content.slice(0, 40),
  );

  // ── 2. The concern turn ───────────────────────────────────────────────
  console.log("\n2. The customer describes their skin");
  console.log("─".repeat(60));

  const concern = await provider.complete(
    makeRequest("আমার ত্বকে অনেক ব্রণ হয়, তেলতেলে। কী ব্যবহার করবো?", [
      { role: "USER", content: "Hi" },
      { role: "ASSISTANT", content: greeting.content },
    ]),
  );
  const concernIntent = detectAdvisorIntent(
    "আমার ত্বকে অনেক ব্রণ হয়, তেলতেলে। কী ব্যবহার করবো?",
  );

  console.log(concern.content);
  console.log("─".repeat(60));

  check(
    "the turn is classified as a concern",
    concernIntent.kind === "CONCERN",
    concernIntent.kind,
  );

  check(
    "a product is recommended now the conversation has earned it",
    concern.recommendedProductIds.length > 0,
    concern.recommendedProductIds.join(", ") || "(none)",
  );

  check(
    "every recommended id is a real candidate",
    concern.recommendedProductIds.every((id) =>
      [CANDIDATE.id, SECOND_CANDIDATE.id].includes(id),
    ),
    concern.recommendedProductIds.join(", ") || "(none)",
  );

  check(
    "the marker line never reaches the customer",
    !concern.content.includes(RECOMMENDATION_MARKER),
  );

  check(
    "the answer is prose, not a JSON envelope",
    !/^\s*[{[]/.test(concern.content),
    concern.content.slice(0, 40),
  );

  // ── 3. The follow-up ──────────────────────────────────────────────────
  console.log("\n3. A follow-up question");
  console.log("─".repeat(60));

  const followUp = await provider.complete(
    makeRequest("এটা কি দিনে ব্যবহার করবো?", [
      { role: "USER", content: "Hi" },
      { role: "ASSISTANT", content: greeting.content },
      {
        role: "USER",
        content: "আমার ত্বকে অনেক ব্রণ হয়, তেলতেলে। কী ব্যবহার করবো?",
      },
      { role: "ASSISTANT", content: concern.content },
    ]),
  );

  console.log(followUp.content);
  console.log("─".repeat(60));

  check(
    "the answer is in Bengali",
    /[ঀ-৿]/.test(followUp.content),
  );

  check(
    "the answer is short enough to be a chat reply",
    followUp.content.length < 1200,
    `${followUp.content.length} characters`,
  );

  check(
    "the marker line never reaches the customer",
    !followUp.content.includes(RECOMMENDATION_MARKER),
  );

  check(
    "the answer is prose, not a JSON envelope",
    !/^\s*[{[]/.test(followUp.content),
    followUp.content.slice(0, 40),
  );

  // ── The result ────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));

  if (failures === 0) {
    console.log("OK — the advisor greeted, then advised when it was asked to.");
    return;
  }

  console.error(`${failures} check(s) failed.`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("The live call failed:", error);
  process.exitCode = 1;
});
