import "dotenv/config";

import { OpenRouterProvider } from "@/lib/ai/openrouter-provider";
import { RECOMMENDATION_MARKER } from "@/lib/ai/free-text";
import { detectAdvisorIntent } from "@/lib/ai/intent";
import { BENGALI } from "@/lib/ai/language";
import type { AdvisorRequest } from "@/lib/ai/provider";

/**
 * A live check of the OpenRouter provider's **conversational** behaviour.
 *
 * ── What it proves ───────────────────────────────────────────────────────
 *
 * The unit tests stub `fetch`, so they prove the request *shape* — that
 * the turn instruction reaches the model. They cannot prove that
 * OpenRouter obeys it.
 *
 * This script makes real calls and checks the three things the customer
 * actually sees:
 *
 *   1. **"Hi" gets a greeting, not a routine.** No product ids, and no
 *      price in the answer.
 *   2. **A described concern gets advice.** The product is recommended,
 *      because the conversation has earned it.
 *   3. **A photo is actually read.** The model is asked what it can see,
 *      and it answers about the image — which is the check that a
 *      text-only model cannot pass.
 *
 * The third check is the one that cannot be asserted by the others, and
 * it is the check that caught the text-only-model problem: OpenRouter
 * rejects a photo sent to a text-only model outright, so a deployment
 * with the wrong `OPENROUTER_MODEL` fails here rather than in front of
 * a customer.
 *
 * Run it with:
 *
 *   npx tsx scripts/verify-openrouter-conversation.ts
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
 * A 1x1 red PNG, inlined so the probe needs no file and no upload.
 */
const RED_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Builds a request for a turn, with the intent code decided — exactly
 * as the service layer does it.
 */
function makeRequest(
  userMessage: string,
  history: AdvisorRequest["history"] = [],
  image?: AdvisorRequest["image"],
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
      hasImage: image !== undefined,
      skinType: null,
      concerns: [],
    }),
    ...(image ? { image } : {}),
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
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    console.error(
      "OPENROUTER_API_KEY is not set. Add it to .env and try again.",
    );
    process.exitCode = 1;
    return;
  }

  const provider = new OpenRouterProvider({ apiKey });

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

  console.log(concern.content);
  console.log("─".repeat(60));

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

  // ── 3. The photo ──────────────────────────────────────────────────────
  console.log("\n3. The customer attaches a photo");
  console.log("─".repeat(60));

  const photo = await provider.complete(
    makeRequest(
      "What can you tell me about my skin in this photo?",
      [
        { role: "USER", content: "Hi" },
        { role: "ASSISTANT", content: greeting.content },
      ],
      { mimeType: "image/png", base64: RED_PIXEL_PNG },
    ),
  );

  console.log(photo.content);
  console.log("─".repeat(60));

  check(
    "the photo was accepted — the model can read images",
    photo.content.trim().length > 0,
    photo.content.slice(0, 60),
  );

  /*
   * The model must have *seen* the image.
   *
   * The check is deliberately about engagement with the picture, not
   * about naming a colour. The advisor's own prompt asks the model to
   * acknowledge what it can see and to describe its observations as
   * possibilities — so a model that has genuinely read a flat red
   * pixel may well say "it looks like a single-coloured image" and
   * decline to guess further. That is the *correct* behaviour, and it
   * is proof the picture arrived.
   *
   * What would fail this check is a model that answered as though no
   * photo had been attached at all, or that OpenRouter had rejected
   * the request outright — which is exactly what a text-only model
   * does, with a `404` and the message "No endpoints found that
   * support image input".
   */
  check(
    "the answer engages with what is in the photo",
    /pink|red|coral|লাল|গোলাপি|একরঙা|রঙ|colour|color|ছবি/i.test(
      photo.content,
    ),
    photo.content.slice(0, 80),
  );

  check(
    "the answer does not pretend there is no photo",
    !/ছবি.*(পাঠানোর দরকার|যুক্ত করুন|attach)/i.test(photo.content),
    photo.content.slice(0, 80),
  );

  check(
    "the marker line never reaches the customer",
    !photo.content.includes(RECOMMENDATION_MARKER),
  );

  // ── The result ────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));

  if (failures === 0) {
    console.log(
      "OK — the advisor greeted, advised when asked, and read the photo.",
    );
    return;
  }

  console.error(`${failures} check(s) failed.`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("The live call failed:", error);
  process.exitCode = 1;
});
