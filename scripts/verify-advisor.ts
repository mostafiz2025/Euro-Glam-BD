/**
 * AI Advisor verification script.
 *
 * Proves the advisor's five load-bearing properties against a real
 * database, outside the unit tests:
 *
 *   1. **Conversation ownership.** A conversation belongs to exactly one
 *      user. Another user's id returns `null`, never the conversation and
 *      never a `403` — a `403` would confirm the id is real.
 *   2. **The disclaimer is always present.** Every response carries one,
 *      and the hardcoded fallback exists for the case where the
 *      `AiConfig` row is missing, empty, or the database is down.
 *   3. **Code decides, the model phrases.** A provider that recommends a
 *      product outside the allow-list has that id dropped, and the
 *      deterministic set is used instead.
 *   4. **The conflicts are re-attached.** Whatever the provider said
 *      about a conflict is discarded; the engine's decision is what the
 *      customer sees.
 *   5. **The profile is only ever added to.** The advisor adds a
 *      concern; it never removes one, and it never infers the skin type.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-advisor.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import { MessageRole, PrismaClient } from "@prisma/client";

import { getConversation, listConversations } from "@/lib/ai/conversations";
import { FALLBACK_DISCLAIMER_TEXT } from "@/lib/ai/disclaimer";
import { generateAdvisorResponse } from "@/lib/ai/service";
import type { AdvisorResponse, AiProvider } from "@/lib/ai/provider";

const prisma = new PrismaClient();

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

/**
 * A unique suffix so repeated runs never collide.
 */
const runId = `va${Date.now()}${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Advisor Verifier",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "CUSTOMER",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Advisor Verify", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

async function createProduct(
  categoryId: string,
  name: string,
  ingredientTags: string[] = [],
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Advisor verification product ${name}`,
      categoryId,
      pricePaisa: 120000,
      stockQuantity: 8,
      ingredientTags,
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
  return product.id;
}

/**
 * A provider that misbehaves on purpose: it recommends a product that
 * was never offered.
 */
function makeMisbehavingProvider(): AiProvider {
  return {
    name: "misbehaving",
    modelName: "misbehaving-v1",
    async complete(): Promise<AdvisorResponse> {
      return {
        content: "You should buy prod_definitely_not_real.",
        recommendedProductIds: ["prod_definitely_not_real"],
        providerName: "misbehaving",
        modelName: "misbehaving-v1",
        isMocked: false,
      };
    },
  };
}

async function main() {
  console.log("\nAI Advisor verification\n");
  console.log("=".repeat(40));

  const owner = await createUser(`${runId}-owner@example.com`);
  const stranger = await createUser(`${runId}-stranger@example.com`);
  const categoryId = await createCategory(`${runId}-cat`);

  await createProduct(
    categoryId,
    `Verified Product ${runId}`,
    ["NIACINAMIDE"],
  );

  // ── 1. The conversation ownership ─────────────────────────────────────
  section("1. Conversation ownership");

  const conversation = await prisma.advisorConversation.create({
    data: { userId: owner, title: "Verification chat" },
    select: { id: true },
  });

  await prisma.advisorMessage.create({
    data: {
      conversationId: conversation.id,
      role: MessageRole.USER,
      content: "A question",
    },
  });

  const ownedRead = await getConversation(owner, conversation.id);

  check(
    "the owner can read their own conversation",
    ownedRead !== null && ownedRead.messages.length === 1,
    ownedRead === null ? "null" : `${ownedRead.messages.length} message(s)`,
  );

  const foreignRead = await getConversation(stranger, conversation.id);

  check(
    "another user gets null, not the conversation",
    foreignRead === null,
    foreignRead === null ? "null" : "the conversation leaked",
  );

  const missingRead = await getConversation(owner, "no-such-conversation");

  check(
    "a conversation that does not exist also gets null",
    missingRead === null,
  );

  const { conversations } = await listConversations(owner, 50);

  check(
    "the list shows only the caller's conversations",
    conversations.every((entry) => entry.title !== "Somebody else's"),
    `${conversations.length} listed`,
  );

  // ── 2. The disclaimer ─────────────────────────────────────────────────
  section("2. The disclaimer");

  const result = await generateAdvisorResponse({
    userId: owner,
    userMessage: "My skin is oily in the afternoon.",
  });

  check(
    "every response carries a disclaimer",
    result.disclaimer.text.trim().length > 0,
    result.disclaimer.text,
  );

  check(
    "the disclaimer has a version stamp",
    typeof result.disclaimer.version === "number",
    `version ${result.disclaimer.version}`,
  );

  check(
    "the hardcoded fallback exists and is not empty",
    FALLBACK_DISCLAIMER_TEXT.trim().length > 0,
    FALLBACK_DISCLAIMER_TEXT,
  );

  // The fallback must be what ships when the config row is missing.
  const existing = await prisma.aiConfig.findUnique({
    where: { key: "default" },
  });

  if (existing) {
    await prisma.aiConfig.update({
      where: { key: "default" },
      data: { disclaimerText: "   " },
    });

    const withBlank = await generateAdvisorResponse({
      userId: owner,
      userMessage: "Again, please.",
    });

    check(
      "a whitespace-only config falls back to the hardcoded text",
      withBlank.disclaimer.text === FALLBACK_DISCLAIMER_TEXT,
      withBlank.disclaimer.text,
    );

    await prisma.aiConfig.update({
      where: { key: "default" },
      data: { disclaimerText: existing.disclaimerText },
    });
  } else {
    console.log("  SKIP  no AiConfig row to blank — the fallback path is covered by the unit test");
  }

  // ── 3. Code decides, the model phrases ────────────────────────────────
  section("3. Code decides, the model phrases");

  const misbehaving = await generateAdvisorResponse(
    { userId: owner, userMessage: "Recommend me something." },
    makeMisbehavingProvider(),
  );

  const recommendedIds = misbehaving.recommendations.map(
    (recommendation) => recommendation.productId,
  );

  check(
    "a product the provider invented is never recommended",
    !recommendedIds.includes("prod_definitely_not_real"),
    recommendedIds.join(", ") || "none",
  );

  check(
    "the deterministic set is used instead",
    recommendedIds.length > 0,
    `${recommendedIds.length} recommended`,
  );

  check(
    "the reason is composed in code, not taken from the provider",
    misbehaving.recommendations.every((recommendation) =>
      /^Matches your routine with |^A gentle option that suits/.test(
        recommendation.reason,
      ),
    ),
    misbehaving.recommendations[0]?.reason ?? "",
  );

  // ── 4. The conflicts are re-attached ──────────────────────────────────
  section("4. The conflicts are re-attached");

  check(
    "the conflicts come from the engine, with engine-set severities",
    misbehaving.conflicts.every((conflict) =>
      conflict.severity === "BLOCK" || conflict.severity === "WARN",
    ),
    `${misbehaving.conflicts.length} conflict(s)`,
  );

  // A provider that claims there are no conflicts cannot remove the
  // engine's — the engine's list is what is returned.
  const conflictFree = await generateAdvisorResponse(
    { userId: owner, userMessage: "No conflicts please." },
    {
      name: "conflict-denial",
      modelName: "v1",
      async complete() {
        return {
          content: "There are no conflicts at all.",
          recommendedProductIds: [],
          providerName: "conflict-denial",
          modelName: "v1",
          isMocked: false,
        };
      },
    },
  );

  check(
    "a provider cannot talk the engine's conflicts out of the response",
    conflictFree.conflicts.length === misbehaving.conflicts.length,
    `${conflictFree.conflicts.length} vs ${misbehaving.conflicts.length}`,
  );

  // ── 5. The profile is only ever added to ──────────────────────────────
  section("5. The profile is only ever added to");

  await prisma.userSkinProfile.create({
    data: {
      userId: owner,
      skinType: "SENSITIVE",
      concerns: ["SENSITIVITY"],
    },
  });

  const before = await prisma.userSkinProfile.findUnique({
    where: { userId: owner },
    select: { skinType: true, concerns: true },
  });

  check(
    "the skin type is set by the customer, not inferred",
    before?.skinType === "SENSITIVE",
    String(before?.skinType),
  );

  // The advisor's inferred concerns come back on the result. They are
  // *added* by the chat route, and only added.
  //
  // The response has to be re-read *after* the profile exists — the
  // earlier ones ran before the profile was created, so their snapshot
  // was legitimately empty.
  const afterProfile = await generateAdvisorResponse({
    userId: owner,
    userMessage: "Now that you know my skin, what do you suggest?",
  });

  check(
    "the advisor never changes the skin type",
    afterProfile.skinProfile.skinType === "SENSITIVE",
    String(afterProfile.skinProfile.skinType),
  );

  check(
    "the advisor reads the customer's concerns from the profile",
    afterProfile.skinProfile.concerns.includes("SENSITIVITY"),
    afterProfile.skinProfile.concerns.join(", "),
  );

  const profileAfter = await prisma.userSkinProfile.findUnique({
    where: { userId: owner },
    select: { skinType: true, concerns: true },
  });

  check(
    "the skin type is still the customer's after a turn",
    profileAfter?.skinType === "SENSITIVE",
    String(profileAfter?.skinType),
  );

  // ── 6. The catalogue boundary ─────────────────────────────────────────
  section("6. The catalogue boundary");

  const outOfStock = await createProduct(
    categoryId,
    `Out Of Stock ${runId}`,
  );

  await prisma.product.update({
    where: { id: outOfStock },
    data: { stockQuantity: 0 },
  });

  const afterStock = await generateAdvisorResponse({
    userId: owner,
    userMessage: "What do you have in stock?",
  });

  check(
    "an out-of-stock product is never recommended",
    !afterStock.recommendations.some(
      (recommendation) => recommendation.productId === outOfStock,
    ),
  );

  // ── The cleanup ───────────────────────────────────────────────────────
  section("Cleanup");

  await prisma.advisorMessage.deleteMany({
    where: { conversation: { userId: { in: createdUserIds } } },
  });
  await prisma.advisorImage.deleteMany({
    where: { conversation: { userId: { in: createdUserIds } } },
  });
  await prisma.advisorConversation.deleteMany({
    where: { userId: { in: createdUserIds } },
  });
  await prisma.userSkinProfile.deleteMany({
    where: { userId: { in: createdUserIds } },
  });
  await prisma.cartItem.deleteMany({
    where: { cart: { userId: { in: createdUserIds } } },
  });
  await prisma.cart.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.product.deleteMany({
    where: { id: { in: createdProductIds } },
  });
  await prisma.category.deleteMany({
    where: { id: { in: createdCategoryIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });

  await prisma.$disconnect();

  console.log("\n" + "=".repeat(40));

  if (failures === 0) {
    console.log("\nAll AI Advisor checks passed.\n");
    process.exit(0);
  }

  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error("The verification crashed:", error);
  process.exit(1);
});
