/**
 * Step 8 verification script.
 *
 * Proves the three deliverables behave correctly outside the unit tests:
 *
 *   1. The storage adapter round-trips a real file on disk, and the
 *      generated key is random, scoped and free of user input.
 *   2. A `.txt` file renamed to `.png` is rejected by magic-byte
 *      validation. This is the test that proves the validation is real.
 *   3. The conflict engine is pure and deterministic — the same input
 *      gives byte-identical output, and the LLM is nowhere in the path.
 *   4. The mock provider is deterministic and needs no API key.
 *
 * Run with:  npx tsx scripts/verify-step8.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateConflicts, CONFLICT_RULES } from "@/lib/conflict-engine";
import { MockProvider } from "@/lib/ai/mock-provider";
import type { AdvisorRequest } from "@/lib/ai/provider";
import { LocalStorageDriver } from "@/lib/storage/local-driver";
import {
  UploadValidationError,
  assertValidImage,
  detectMimeType,
} from "@/lib/upload/validate";

/**
 * A 1×1 PNG.
 */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/**
 * A plain-text file. Not an image.
 */
const TEXT_FILE = Buffer.from(
  "This file is a text file. Renaming it to .png does not make it a PNG.\n",
  "utf8",
);

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

/**
 * Section heading.
 */
function section(title: string): void {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
}

async function main(): Promise<void> {
  console.log("Euro Glam BD — Step 8 verification\n");

  // ── 1. Storage round trip ────────────────────────────────────────────
  section("1. Storage adapter round trip");

  const root = await mkdtemp(path.join(tmpdir(), "egb-verify-"));
  const driver = new LocalStorageDriver({ root });

  const stored = await driver.put({
    bytes: PNG_1X1,
    mimeType: "image/png",
    originalName: "holiday photo.png",
    scope: "advisor",
  });

  console.log(`  key: ${stored.key}`);

  check(
    "the key is scoped and dated",
    /^advisor\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/.test(stored.key),
    stored.key,
  );

  check(
    "the key contains no part of the original filename",
    !stored.key.includes("holiday") && !stored.key.includes("photo"),
  );

  const readBack = await driver.read(stored.key);
  check("the bytes round-trip exactly", readBack.equals(PNG_1X1));

  const url = driver.getUrl(stored.key);
  check("the URL is served from /uploads", url === `/uploads/${stored.key}`, url);

  check("the object exists", await driver.exists(stored.key));

  await driver.delete(stored.key);
  check("the object is gone after delete", !(await driver.exists(stored.key)));

  // Idempotency: the cleanup job calls delete() repeatedly.
  await driver.delete(stored.key);
  check("delete is idempotent", !(await driver.exists(stored.key)));

  // Two uploads of identical bytes must not collide.
  const first = await driver.put({
    bytes: PNG_1X1,
    mimeType: "image/png",
    originalName: "same.png",
    scope: "advisor",
  });
  const second = await driver.put({
    bytes: PNG_1X1,
    mimeType: "image/png",
    originalName: "same.png",
    scope: "advisor",
  });

  check("identical uploads get different keys", first.key !== second.key);

  // Path traversal.
  let traversalBlocked = false;
  try {
    await driver.exists("../../etc/passwd");
  } catch {
    traversalBlocked = true;
  }
  check("a traversing key is refused", traversalBlocked);

  await rm(root, { recursive: true, force: true });

  // ── 2. Upload validation ─────────────────────────────────────────────
  section("2. Upload validation — magic bytes are the real check");

  check("a PNG is detected", detectMimeType(PNG_1X1) === "image/png");
  check("a text file is not detected as an image", detectMimeType(TEXT_FILE) === null);

  let textRejected = false;
  let rejectionCode = "";
  try {
    // The declared type says image/png. The bytes say text. It must fail.
    assertValidImage(TEXT_FILE, "image/png");
  } catch (error) {
    textRejected = true;
    rejectionCode = (error as UploadValidationError).code;
  }

  check(
    "a .txt renamed to .png is rejected",
    textRejected,
    `code: ${rejectionCode}`,
  );

  let mismatchRejected = false;
  try {
    // Real PNG bytes, but the client claimed JPEG.
    assertValidImage(PNG_1X1, "image/jpeg");
  } catch {
    mismatchRejected = true;
  }
  check("a declared type that disagrees with the bytes is rejected", mismatchRejected);

  const validated = assertValidImage(PNG_1X1, "image/png");
  check(
    "a valid PNG passes and reports its dimensions",
    validated.width === 1 && validated.height === 1,
    `${validated.width}×${validated.height}`,
  );

  // ── 3. Conflict engine ───────────────────────────────────────────────
  section("3. Conflict engine — pure and deterministic");

  const products = [
    { id: "prod_retinol", ingredientTags: ["RETINOL"] },
    { id: "prod_aha", ingredientTags: ["GLYCOLIC_ACID", "NIACINAMIDE"] },
    { id: "prod_vitc", ingredientTags: ["VITAMIN_C"] },
    { id: "prod_vitc2", ingredientTags: ["VITAMIN_C"] },
  ];

  const evaluation = evaluateConflicts(products);
  const repeat = evaluateConflicts(products);

  console.log(`  rules fired: ${evaluation.conflicts.map((c) => `${c.ruleId}[${c.severity}]`).join(", ")}`);

  check(
    "a retinol + AHA is BLOCKed",
    evaluation.conflicts.some(
      (c) => c.ruleId === "AHA_RETINOL_BLOCK" && c.severity === "BLOCK",
    ),
  );

  check(
    "two vitamin-C products WARN",
    evaluation.conflicts.some((c) => c.ruleId === "VITAMIN_C_DUPLICATE_WARN"),
  );

  check(
    "BLOCK conflicts are ordered before WARN",
    evaluation.conflicts.every((conflict, index, all) => {
      if (index === 0) return true;
      const previous = all[index - 1];
      if (!previous) return true;
      if (previous.severity === "BLOCK") return true;
      return conflict.severity === "WARN";
    }),
  );

  check(
    "the engine is deterministic",
    JSON.stringify(repeat) === JSON.stringify(evaluation),
  );

  check("the rule set is non-empty", CONFLICT_RULES.length > 0, `${CONFLICT_RULES.length} rules`);

  // ── 4. Mock provider ────────────────────────────────────────────────
  section("4. AI provider — deterministic mock, no API key");

  const request: AdvisorRequest = {
    userMessage: "My skin is oily and breaking out. What should I use?",
    profile: { skinType: "OILY", concerns: ["acne"], notes: null },
    candidates: [
      {
        id: "prod_niacinamide",
        name: "Niacinamide 10% Serum",
        categoryName: "Skincare",
        pricePaisa: 120000,
        discountPricePaisa: null,
        ingredientTags: ["NIACINAMIDE"],
        climateTips: null,
        description: "A balancing serum for oily skin.",
      },
    ],
    conflicts: [],
    allowedProductIds: null,
    systemPrompt: null,
  };

  const provider = new MockProvider();
  const responseA = await provider.complete(request);
  const responseB = await provider.complete(request);

  check("the mock is marked as mocked", responseA.isMocked);
  check("the mock is deterministic", responseA.content === responseB.content);
  check(
    "the mock recommends only from the candidate list",
    responseA.recommendedProductIds.every((id) => id === "prod_niacinamide"),
  );

  console.log("\n  sample response:");
  console.log(
    responseA.content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );

  // ── Result ───────────────────────────────────────────────────────────
  console.log("");
  if (failures === 0) {
    console.log("All Step 8 checks passed.");
    process.exit(0);
  }

  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
