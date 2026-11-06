import "dotenv/config";

import { OpenRouterProvider } from "@/lib/ai/openrouter-provider";
import { RECOMMENDATION_MARKER } from "@/lib/ai/free-text";
import { detectAdvisorIntent } from "@/lib/ai/intent";
import { BENGALI } from "@/lib/ai/language";
import type { AdvisorRequest } from "@/lib/ai/provider";

/**
 * A live smoke test for the OpenRouter provider.
 *
 * ── What it proves ───────────────────────────────────────────────────────
 *
 * The unit tests stub `fetch`, so they prove the request *shape*. They
 * cannot prove that OpenRouter accepts that shape, that the configured
 * model exists on OpenRouter, or that the API key works. This script
 * makes one real call and checks that the advice comes back, in the
 * right language, with the recommended ids intact.
 *
 * It is the script that catches the failure mode this provider was
 * added for: a deployment pointing at a model that OpenRouter does not
 * serve, or a key that has been revoked, produces a hard error here
 * rather than a failed advisor turn in front of a customer.
 *
 * Run it with:
 *
 *   npx tsx scripts/verify-openrouter.ts
 *
 * It needs `OPENROUTER_API_KEY` in the environment. It does not write to
 * the database, and it does not touch the storefront.
 */

const CANDIDATE = {
  id: "prod_niacinamide",
  name: "Niacinamide 10% Serum",
  categoryName: "Skincare",
  pricePaisa: 120000,
  discountPricePaisa: null,
  ingredientTags: ["NIACINAMIDE"],
  climateTips: null,
  description: "A balancing serum for oily skin.",
};

const REQUEST: AdvisorRequest = {
  userMessage: "My skin is oily and I have dark spots. What should I use?",
  profile: {
    skinType: "OILY",
    concerns: ["OILINESS", "DARK_SPOTS"],
    notes: null,
  },
  candidates: [CANDIDATE],
  conflicts: [],
  allowedProductIds: [CANDIDATE.id],
  systemPrompt: null,
  history: [
    { role: "USER", content: "Hello, I am 24 and live in Dhaka." },
    { role: "ASSISTANT", content: "Hello! Tell me about your skin." },
  ],
  language: BENGALI,
  intent: detectAdvisorIntent(
    "My skin is oily and I have dark spots. What should I use?",
  ),
};

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
  console.log("─".repeat(60));

  const started = Date.now();
  const response = await provider.complete(REQUEST);
  const elapsed = Date.now() - started;

  console.log(`Elapsed  : ${elapsed}ms`);
  console.log(`Mocked   : ${response.isMocked}`);
  console.log(
    `Products : ${response.recommendedProductIds.join(", ") || "(none)"}`,
  );
  console.log("─".repeat(60));
  console.log(response.content);
  console.log("─".repeat(60));

  // ── The checks ─────────────────────────────────────────────────────────
  const problems: string[] = [];

  if (response.content.trim().length === 0) {
    problems.push("the response is empty");
  }

  if (!response.recommendedProductIds.includes(CANDIDATE.id)) {
    problems.push(
      `the allowed product ${CANDIDATE.id} was not recommended (got ${response.recommendedProductIds.join(", ") || "none"})`,
    );
  }

  for (const id of response.recommendedProductIds) {
    if (id !== CANDIDATE.id) {
      problems.push(`an id outside the allow-list was recommended: ${id}`);
    }
  }

  // The marker line is machine-readable and must never reach a customer.
  if (response.content.includes(RECOMMENDATION_MARKER)) {
    problems.push("the marker line reached the customer");
  }

  // The advisor was asked to answer in Bengali. Latin script here would
  // mean the language rule did not reach the model.
  if (!/[ঀ-৿]/.test(response.content)) {
    problems.push("the answer is not in Bengali script");
  }

  if (problems.length > 0) {
    console.error("FAILED:");
    for (const problem of problems) {
      console.error(`  • ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("OK — OpenRouter answered in Bengali with the allowed product.");
}

main().catch((error: unknown) => {
  console.error("The live call failed:", error);
  process.exitCode = 1;
});
