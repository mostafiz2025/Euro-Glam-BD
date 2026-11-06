import "dotenv/config";

import { GeminiProvider } from "@/lib/ai/gemini-provider";
import { BENGALI } from "@/lib/ai/language";
import type { AdvisorRequest } from "@/lib/ai/provider";

/**
 * A live smoke test for the Gemini provider.
 *
 * ── What it proves ───────────────────────────────────────────────────────
 *
 * The unit tests inject a stubbed SDK client, so they prove the request
 * *shape*. They cannot prove that Google accepts that shape. This script
 * makes one real call and checks that the advice comes back, in the
 * right language, with the recommended ids intact.
 *
 * Run it with:
 *
 *   npx tsx scripts/verify-gemini.ts
 *
 * It needs `GEMINI_API_KEY` in the environment. It does not write to the
 * database, and it does not touch the storefront.
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
};

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
  console.log("─".repeat(60));

  const started = Date.now();
  const response = await provider.complete(REQUEST);
  const elapsed = Date.now() - started;

  console.log(`Elapsed  : ${elapsed}ms`);
  console.log(`Mocked   : ${response.isMocked}`);
  console.log(`Products : ${response.recommendedProductIds.join(", ") || "(none)"}`);
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

  console.log("OK — Gemini answered in Bengali with the allowed product.");
}

main().catch((error: unknown) => {
  console.error("The live call failed:", error);
  process.exitCode = 1;
});
