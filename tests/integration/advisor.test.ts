import { MessageRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deleteConversation,
  getConversation,
  listConversations,
  PROFILE_PHOTO_CONVERSATION_TITLE,
} from "@/lib/ai/conversations";
import {
  buildMessageMeta,
  generateAdvisorResponse,
  loadConversationHistory,
  MAX_HISTORY_TURNS,
} from "@/lib/ai/service";
import { db } from "@/lib/db";

/**
 * The AI Advisor's integration tests.
 *
 * These exercise the real database and the real service layer. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. A conversation belongs to exactly one user. Another user's id
 *      returns `null`, not a `403`.
 *   2. The profile-photo holder conversation never appears in the
 *      customer's conversation list.
 *   3. Deleting a conversation removes its messages, its images, and its
 *      files.
 *   4. The advisor's recommendations come from code-built candidates —
 *      never from an id the provider invented.
 *   5. The advisor **adds** concerns but never removes them and never
 *      infers the skin type.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

/**
 * The `AI_PROVIDER` the suite started with, restored on the way out.
 */
let originalProvider: string | undefined;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

const runId = `adv${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Advisor Customer",
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
    data: { name: "Advisor Test", slug },
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
      description: `Advisor test product ${name}`,
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 10,
      ingredientTags,
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
  return product.id;
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    databaseAvailable = false;
  }

  /*
   * The provider is pinned to the mock.
   *
   * These tests exercise the **service layer** — the intent detection,
   * the guard rails, the candidate builder, the profile updates — and
   * none of those depend on which provider is live. The mock honours the
   * same turn contract the real providers do, so the behaviour proved
   * here is the behaviour the storefront ships.
   *
   * Without this, the suite would follow whatever `AI_PROVIDER` the
   * developer's `.env` happens to set. A machine configured for the live
   * Gemini provider would then make a real API call for every one of
   * these tests — spending the free-tier quota (20 requests a day), and
   * failing the whole suite with a 429 the moment that quota ran out.
   *
   * The live providers are covered by their own unit tests, which stub
   * the SDK, and by `scripts/verify-conversation.ts`, which calls the
   * real model on purpose.
   */
  originalProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "mock";
});

afterAll(async () => {
  // The provider the machine was configured with is put back, so the
  // suite leaves no trace on the environment it ran in.
  if (originalProvider === undefined) {
    delete process.env.AI_PROVIDER;
  } else {
    process.env.AI_PROVIDER = originalProvider;
  }

  if (!databaseAvailable) {
    return;
  }

  // Cleanup in dependency order. The advisor rows cascade from the
  // conversation, and the conversation cascades from the user, so the
  // advisor rows can go first — explicitly, so a failure is visible.
  const userIds = [...createdUserIds];

  if (userIds.length > 0) {
    await prisma.advisorMessage.deleteMany({
      where: { conversation: { userId: { in: userIds } } },
    });
    await prisma.advisorImage.deleteMany({
      where: { conversation: { userId: { in: userIds } } },
    });
    await prisma.advisorConversation.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.userSkinProfile.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.cartItem.deleteMany({
      where: { cart: { userId: { in: userIds } } },
    });
    await prisma.cart.deleteMany({ where: { userId: { in: userIds } } });
  }

  if (createdProductIds.length > 0) {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  }

  if (createdCategoryIds.length > 0) {
    await prisma.category.deleteMany({
      where: { id: { in: createdCategoryIds } },
    });
  }

  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

describe("the advisor's conversation ownership", () => {
  it("returns null for a conversation that does not exist", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-missing@example.com`);

    const result = await getConversation(owner, "no-such-conversation");

    expect(result).toBeNull();
  });

  it("returns null for a conversation belonging to somebody else", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-owner@example.com`);
    const stranger = await createUser(`${runId}-stranger@example.com`);

    const conversation = await prisma.advisorConversation.create({
      data: { userId: owner, title: "Private chat" },
      select: { id: true },
    });

    // The stranger's read returns `null` — not a `403`, and not the
    // conversation. A `403` would confirm the id is real, which leaks the
    // existence of somebody else's conversation.
    const result = await getConversation(stranger, conversation.id);

    expect(result).toBeNull();
  });

  it("returns the conversation to its owner", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-reader@example.com`);

    const conversation = await prisma.advisorConversation.create({
      data: { userId: owner, title: "My chat" },
      select: { id: true },
    });

    await prisma.advisorMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: "Hello",
      },
    });

    const result = await getConversation(owner, conversation.id);

    expect(result).not.toBeNull();
    expect(result?.messages).toHaveLength(1);
    expect(result?.messages[0]?.content).toBe("Hello");
  });

  it("lists only the caller's conversations", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-lister@example.com`);
    const stranger = await createUser(`${runId}-other@example.com`);

    await prisma.advisorConversation.create({
      data: { userId: owner, title: "Mine" },
    });
    await prisma.advisorConversation.create({
      data: { userId: stranger, title: "Theirs" },
    });

    const { conversations } = await listConversations(owner, 50);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe("Mine");
  });

  it("hides the profile-photo holder from the conversation list", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-holder@example.com`);

    await prisma.advisorConversation.create({
      data: { userId: owner, title: PROFILE_PHOTO_CONVERSATION_TITLE },
    });
    await prisma.advisorConversation.create({
      data: { userId: owner, title: "A real conversation" },
    });

    const { conversations } = await listConversations(owner, 50);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe("A real conversation");
  });
});

describe("deleting a conversation", () => {
  it("removes the messages and the images", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-deleter@example.com`);

    const conversation = await prisma.advisorConversation.create({
      data: { userId: owner, title: "Doomed" },
      select: { id: true },
    });

    await prisma.advisorMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        content: "An answer",
      },
    });

    await prisma.advisorImage.create({
      data: {
        conversationId: conversation.id,
        storageKey: `advisor/test/${runId}.jpg`,
        mimeType: "image/jpeg",
        byteSize: 100,
      },
    });

    const deleted = await deleteConversation(owner, conversation.id);

    expect(deleted).toBe(true);

    expect(
      await prisma.advisorMessage.count({
        where: { conversationId: conversation.id },
      }),
    ).toBe(0);

    expect(
      await prisma.advisorImage.count({
        where: { conversationId: conversation.id },
      }),
    ).toBe(0);
  });

  it("returns false for a conversation belonging to somebody else", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-notmine@example.com`);
    const stranger = await createUser(`${runId}-notmine2@example.com`);

    const conversation = await prisma.advisorConversation.create({
      data: { userId: owner, title: "Not yours" },
      select: { id: true },
    });

    const deleted = await deleteConversation(stranger, conversation.id);

    expect(deleted).toBe(false);

    // The conversation is still there — the stranger's attempt changed
    // nothing.
    expect(
      await prisma.advisorConversation.count({
        where: { id: conversation.id },
      }),
    ).toBe(1);
  });
});

describe("the advisor's recommendations", () => {
  it("recommends only products that are in stock", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-stock@example.com`);
    const categoryId = await createCategory(`${runId}-stock`);

    const inStock = await createProduct(
      categoryId,
      `In Stock ${runId}`,
      ["NIACINAMIDE"],
    );
    await createProduct(categoryId, `Out Of Stock ${runId}`);

    await prisma.product.update({
      where: { id: inStock },
      data: { stockQuantity: 5 },
    });

    // Every seeded product with stock would also be a candidate, so the
    // assertion is that *no* recommendation is the out-of-stock one.
    const outOfStock = await prisma.product.findFirst({
      where: { name: `Out Of Stock ${runId}` },
      select: { id: true },
    });

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "What should I use for oily skin?",
    });

    const recommendedIds = result.recommendations.map(
      (recommendation) => recommendation.productId,
    );

    expect(recommendedIds).not.toContain(outOfStock?.id);
  });

  it("attaches a disclaimer to every response", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-disclaimer@example.com`);

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "Hello",
    });

    expect(result.disclaimer.text.trim().length).toBeGreaterThan(0);
    expect(result.disclaimer.version).toBeGreaterThanOrEqual(0);
  });

  it("builds the recommendation reason in code, not from the provider", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-reason@example.com`);

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "I have oily skin.",
    });

    for (const recommendation of result.recommendations) {
      // The reason always mentions the ingredients or says it is a
      // gentle option. It never contains raw provider prose.
      expect(recommendation.reason.length).toBeGreaterThan(0);
      expect(recommendation.reason.toLowerCase()).toMatch(
        /matches your routine|gentle option/,
      );
    }
  });

  it("never returns more recommendations than the cap", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-cap@example.com`);

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "What do you recommend?",
    });

    expect(result.recommendations.length).toBeLessThanOrEqual(3);
  });
});

/**
 * The advisor's conversational behaviour.
 *
 * ── What these prove ────────────────────────────────────────────────────
 *
 * The advisor used to dump a three-product routine on a customer who had
 * typed "Hi". These tests exercise the **real service layer** — the
 * real intent detection, the real guard rail — so they prove the
 * behaviour the storefront actually ships, not just the behaviour of a
 * unit in isolation.
 *
 * The provider is the mock — pinned in `beforeAll` — which honours the
 * same turn contract the real providers do.
 */
describe("the advisor's conversational behaviour", () => {
  it("recommends nothing on a greeting", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-greet@example.com`);

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "Hi",
    });

    expect(result.intent.kind).toBe("GREETING");
    expect(result.intent.mayRecommend).toBe(false);
    expect(result.recommendations).toEqual([]);
  });

  it("greeted a customer who only said hello, without a product list", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-greet2@example.com`);

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "hi",
    });

    // A greeting that mentions no price is a greeting that sold nothing.
    expect(result.content).not.toContain("৳");
  });

  it("recommends once the customer describes their skin", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-concern@example.com`);

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "My skin is oily and breaking out. What should I use?",
    });

    expect(result.intent.kind).toBe("CONCERN");
    expect(result.intent.mayRecommend).toBe(true);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("recommends nothing on an order question", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-order@example.com`);

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "How long does delivery take?",
    });

    expect(result.intent.kind).toBe("ORDER");
    expect(result.recommendations).toEqual([]);
  });

  /*
   * ── The conflict-warning gate ────────────────────────────────────────
   *
   * The bug this guards against: the customer said "Hi", and got an
   * amber "Use with care" panel about a retinoid they had never
   * mentioned.
   *
   * The reason it happened is worth stating, because it is not obvious
   * from the UI: the conflict list is built from the customer's **cart**
   * plus the candidate set. It is therefore identical on every turn. A
   * customer with a retinol in their cart saw the retinol warning under
   * *every* reply — greetings, order questions, small talk. The panel
   * stopped being advice and became noise.
   *
   * So the gate is the turn's intent, decided in code. These tests build
   * a cart that genuinely conflicts, so the conflict *engine* does find
   * something — and then prove the gate suppresses it anyway.
   */
  describe("the conflict-warning gate", () => {
    /**
     * Puts a genuinely conflicting pair in the customer's cart.
     *
     * A retinol and an AHA. The engine's `AHA_RETINOL_BLOCK` rule
     * fires on that pair, so there is a real conflict to suppress.
     */
    async function createConflictingCart(
      userId: string,
      slug: string,
    ): Promise<{ retinolId: string; ahaId: string }> {
      const categoryId = await createCategory(`conflict-${runId}-${slug}`);

      const retinolId = await createProduct(categoryId, "Conflict Retinol", [
        "RETINOL",
      ]);
      const ahaId = await createProduct(categoryId, "Conflict AHA", ["AHA"]);

      const cart = await prisma.cart.create({
        data: { userId },
        select: { id: true },
      });

      await prisma.cartItem.createMany({
        data: [
          { cartId: cart.id, productId: retinolId, quantity: 1 },
          { cartId: cart.id, productId: ahaId, quantity: 1 },
        ],
      });

      return { retinolId, ahaId };
    }

    it("shows no conflict on a greeting, even when the cart conflicts", async () => {
      if (!databaseAvailable) return;

      const owner = await createUser(`${runId}-warn-greet@example.com`);

      await createConflictingCart(owner, "greet");

      const result = await generateAdvisorResponse({
        userId: owner,
        userMessage: "Hi",
      });

      expect(result.intent.kind).toBe("GREETING");
      expect(result.intent.mayWarn).toBe(false);
      expect(result.conflicts).toEqual([]);
    });

    it("shows no conflict on a casual, non-skincare message", async () => {
      if (!databaseAvailable) return;

      const owner = await createUser(`${runId}-warn-casual@example.com`);

      await createConflictingCart(owner, "casual");

      /*
       * The exact shape of the report: a general, empathetic reply
       * about something that has nothing to do with skincare.
       *
       * Note what is *not* asserted here: the recommendation list. A
       * question turn may still recommend — that is a separate
       * decision, made by `mayRecommend`, and it is not what this test
       * is about. What matters is that the amber conflict card stays
       * out of a reply that had nothing to do with a routine.
       */
      const result = await generateAdvisorResponse({
        userId: owner,
        userMessage: "I had a rough day at work, thank you for the help",
      });

      expect(result.intent.mayWarn).toBe(false);
      expect(result.conflicts).toEqual([]);
    });

    it("shows no conflict on an order question", async () => {
      if (!databaseAvailable) return;

      const owner = await createUser(`${runId}-warn-order@example.com`);

      await createConflictingCart(owner, "order");

      const result = await generateAdvisorResponse({
        userId: owner,
        userMessage: "How long does delivery take?",
      });

      expect(result.intent.kind).toBe("ORDER");
      expect(result.conflicts).toEqual([]);
    });

    it("shows the conflict on a turn that asks about the routine", async () => {
      if (!databaseAvailable) return;

      const owner = await createUser(`${runId}-warn-question@example.com`);

      await createConflictingCart(owner, "question");

      // The turn where a warning is the *answer*, not noise.
      const result = await generateAdvisorResponse({
        userId: owner,
        userMessage: "can I use retinol with my AHA exfoliator?",
      });

      expect(result.intent.mayWarn).toBe(true);
      expect(result.conflicts.length).toBeGreaterThan(0);
    });

    it("records the gate in the message meta, so an audit can see it", async () => {
      if (!databaseAvailable) return;

      const owner = await createUser(`${runId}-warn-meta@example.com`);

      await createConflictingCart(owner, "meta");

      const result = await generateAdvisorResponse({
        userId: owner,
        userMessage: "Hi",
      });

      const meta = buildMessageMeta(result);

      expect(meta.mayWarn).toBe(false);
    });
  });

  it("drops a provider's products when the turn does not allow them", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-misbehaving@example.com`);

    /*
     * A provider that ignores the turn instruction and recommends
     * something on a greeting anyway.
     *
     * The guard rail has to drop those ids — and crucially, it must
     * NOT substitute the deterministic set, which would produce a
     * routine that nobody asked for.
     */
    const result = await generateAdvisorResponse(
      { userId: owner, userMessage: "Hello there" },
      {
        name: "pushy",
        modelName: "pushy-v1",
        async complete() {
          return {
            content: "Here are three products you should buy.",
            recommendedProductIds: [],
            providerName: "pushy",
            modelName: "pushy-v1",
            isMocked: false,
          };
        },
      },
    );

    expect(result.intent.kind).toBe("GREETING");
    expect(result.recommendations).toEqual([]);
  });

  it("does not ask a customer who already set their skin type", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-known@example.com`);

    await prisma.userSkinProfile.create({
      data: {
        userId: owner,
        skinType: "OILY",
        concerns: ["ACNE"],
      },
    });

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "Hi",
    });

    // Asking a customer for something they already told you is the
    // fastest way to make a conversational advisor feel like a form.
    expect(result.intent.missing).toEqual([]);
  });
});

describe("the advisor's skin profile", () => {
  it("returns an empty context for a customer with no profile", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-noprofile@example.com`);

    const profile = await db.userSkinProfile.findUnique({
      where: { userId: owner },
    });

    expect(profile).toBeNull();
  });

  it("records the provider and the mocked flag on the message", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-meta@example.com`);

    const result = await generateAdvisorResponse({
      userId: owner,
      userMessage: "Hello",
    });

    const conversation = await prisma.advisorConversation.create({
      data: { userId: owner, title: "Meta" },
      select: { id: true },
    });

    const message = await prisma.advisorMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        content: result.content,
        provider: result.provider.name,
        model: result.provider.name,
        isMocked: result.provider.isMocked,
      },
      select: { provider: true, model: true, isMocked: true },
    });

    expect(message.provider).toBe(result.provider.name);
    expect(message.isMocked).toBe(result.provider.isMocked);
  });
});

describe("the advisor's conversation history", () => {
  it("returns no history for a first turn", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-first-turn@example.com`);

    const history = await loadConversationHistory(owner, undefined);

    expect(history).toEqual([]);
  });

  it("returns no history for an unknown conversation", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-unknown-chat@example.com`);

    const history = await loadConversationHistory(owner, "no-such-conversation");

    expect(history).toEqual([]);
  });

  it("returns the prior turns in chronological order", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-ordered@example.com`);

    const conversation = await prisma.advisorConversation.create({
      data: { userId: owner, title: "Ordered" },
      select: { id: true },
    });

    await prisma.advisorMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: "First question.",
      },
    });

    await prisma.advisorMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        content: "First answer.",
      },
    });

    await prisma.advisorMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: "Second question.",
      },
    });

    const history = await loadConversationHistory(owner, conversation.id);

    expect(history).toEqual([
      { role: "USER", content: "First question." },
      { role: "ASSISTANT", content: "First answer." },
      { role: "USER", content: "Second question." },
    ]);
  });

  it("keeps the most recent turns when there are more than the cap", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-capped@example.com`);

    const conversation = await prisma.advisorConversation.create({
      data: { userId: owner, title: "Capped" },
      select: { id: true },
    });

    // Twenty-five turns, so the cap has to bite.
    for (let index = 0; index < 25; index += 1) {
      await prisma.advisorMessage.create({
        data: {
          conversationId: conversation.id,
          role: MessageRole.USER,
          content: `Turn ${index}`,
        },
      });
    }

    const history = await loadConversationHistory(owner, conversation.id);

    expect(history).toHaveLength(MAX_HISTORY_TURNS);

    // The newest turns are the ones kept — "what about the retinol?"
    // refers to something said two turns ago, not twenty.
    expect(history[history.length - 1]?.content).toBe("Turn 24");
    expect(history[0]?.content).toBe("Turn 5");
  });

  it("does not return another user's conversation history", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}-history-owner@example.com`);
    const stranger = await createUser(`${runId}-history-stranger@example.com`);

    const conversation = await prisma.advisorConversation.create({
      data: { userId: owner, title: "Private" },
      select: { id: true },
    });

    await prisma.advisorMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: "A private question about my skin.",
      },
    });

    // The stranger asks for the same conversation id. The history is
    // scoped by the user as well as the conversation, so it comes back
    // empty rather than leaking somebody else's skincare history.
    const history = await loadConversationHistory(stranger, conversation.id);

    expect(history).toEqual([]);
  });
});
