import { describe, expect, it } from "vitest";

import {
  describeAdvisorIntent,
  detectAdvisorIntent,
  GREETING_INTENT,
} from "@/lib/ai/intent";

/**
 * The advisor's turn-intent detection.
 *
 * ── What these tests are really about ─────────────────────────────────────
 *
 * The behaviour this module exists to guarantee is narrow and blunt:
 * **a greeting must not produce a product list.**
 *
 * Everything else — a concern being recognised, a question being
 * recognised, an order question being told apart from a skincare
 * question — matters because those are the classifications that decide
 * *when* products are appropriate. A misclassification in either
 * direction is a bug: a greeting treated as a concern dumps a routine,
 * and a concern treated as a question withholds the advice the customer
 * asked for.
 *
 * So the tests below are mostly about the edges: the messages that look
 * like one thing and are another.
 */
describe("detectAdvisorIntent", () => {
  describe("greetings", () => {
    it("reads a bare greeting as a greeting", () => {
      for (const message of [
        "hi",
        "Hi",
        "HI",
        "hey",
        "hello",
        "Hello!",
        "good morning",
        "salam",
        "assalamualaikum",
      ]) {
        const intent = detectAdvisorIntent(message);

        expect(intent.kind).toBe("GREETING");
        expect(intent.mayRecommend).toBe(false);
      }
    });

    it("reads a greeting with small talk as a greeting", () => {
      // "hi how are you" is a greeting. The filler words are what make
      // it one.
      for (const message of [
        "hi how are you",
        "hey there",
        "hello, how are you doing today?",
        "good morning!",
        "hi, hope you are doing well",
      ]) {
        expect(detectAdvisorIntent(message).kind).toBe("GREETING");
      }
    });

    it("reads a Bengali greeting as a greeting", () => {
      for (const message of ["হ্যালো", "সালাম", "শুভ সকাল"]) {
        expect(detectAdvisorIntent(message).kind).toBe("GREETING");
      }
    });

    it("does not read a message with real content as a greeting", () => {
      // The failure this guards against: "hi" plus a skin complaint is
      // a complaint, not a greeting. Treating it as a greeting would
      // make the advisor ask the customer to describe their skin — the
      // thing they just did.
      for (const message of [
        "hi my pores are huge",
        "hello, I have oily skin",
        "hey, what should I use for acne?",
        "hi, my skin is very sensitive",
      ]) {
        const intent = detectAdvisorIntent(message);

        expect(intent.kind).not.toBe("GREETING");
      }
    });

    it("never allows a recommendation on a greeting", () => {
      // The single most important assertion in this file.
      const intent = detectAdvisorIntent("hello");

      expect(intent.mayRecommend).toBe(false);
    });
  });

  describe("concerns", () => {
    it("reads a described skin type as a concern", () => {
      for (const message of [
        "my skin is oily",
        "I have oily skin in the afternoon",
        "my skin is very sensitive and it stings",
        "I have combination skin",
        "my skin is dry and flaky",
      ]) {
        const intent = detectAdvisorIntent(message);

        expect(intent.kind).toBe("CONCERN");
        expect(intent.mayRecommend).toBe(true);
      }
    });

    it("reads a described problem as a concern", () => {
      for (const message of [
        "I have dark spots on my cheeks",
        "I keep getting acne on my forehead",
        "my skin is dull lately",
        "I have large pores and blackheads",
        "my face gets red and irritated",
      ]) {
        expect(detectAdvisorIntent(message).kind).toBe("CONCERN");
      }
    });

    it("reads a Bengali concern as a concern", () => {
      const intent = detectAdvisorIntent("আমার ত্বকে অনেক ব্রণ হয়");

      expect(intent.kind).toBe("CONCERN");
      expect(intent.mayRecommend).toBe(true);
    });

    it("reads a question that describes a skin as a concern, not a question", () => {
      // "why is my skin so oily" is both. The concern is the more
      // useful fact — it tells the advisor what the advice is about.
      const intent = detectAdvisorIntent("why is my skin so oily?");

      expect(intent.kind).toBe("CONCERN");
      expect(intent.mayRecommend).toBe(true);
    });
  });

  describe("questions", () => {
    it("reads a specific question as a question", () => {
      for (const message of [
        "how do I use retinol?",
        "what is niacinamide?",
        "can I use this with my sunscreen?",
        "which one should I start with?",
        "tell me about the cleanser",
      ]) {
        const intent = detectAdvisorIntent(message);

        expect(intent.kind).toBe("QUESTION");
        expect(intent.mayRecommend).toBe(true);
      }
    });

    it("reads an unrecognisable message as a question, not a concern", () => {
      // Nothing in the message described a skin, so there is nothing
      // for a routine to be built on.
      const intent = detectAdvisorIntent("hmm okay");

      expect(intent.kind).toBe("QUESTION");
      expect(intent.mayRecommend).toBe(true);
    });
  });

  describe("orders", () => {
    it("reads a question about the shop as an order question", () => {
      for (const message of [
        "how long does delivery take?",
        "can I pay with bkash?",
        "where is my order?",
        "do you have a coupon?",
        "what is your return policy?",
      ]) {
        const intent = detectAdvisorIntent(message);

        expect(intent.kind).toBe("ORDER");
        expect(intent.mayRecommend).toBe(false);
      }
    });

    it("still reads a message that describes a skin and mentions an order as a concern", () => {
      // "I want to order a serum for my oily skin" describes a skin.
      // The advice should be about the skin, not about the order.
      const intent = detectAdvisorIntent(
        "I want to order a serum for my oily skin",
      );

      expect(intent.kind).toBe("CONCERN");
      expect(intent.mayRecommend).toBe(true);
    });
  });

  describe("a photo", () => {
    it("treats a photo as a concern even when the message is a greeting", () => {
      // A customer who attaches a picture of their face and says "hi"
      // wants the picture looked at. Telling them to describe their
      // skin instead would be exactly backwards.
      const intent = detectAdvisorIntent("hi", { hasImage: true });

      expect(intent.kind).toBe("CONCERN");
      expect(intent.mayRecommend).toBe(true);
    });

    it("treats a photo with no text at all as a concern", () => {
      const intent = detectAdvisorIntent("", { hasImage: true });

      expect(intent.kind).toBe("CONCERN");
    });
  });

  describe("what the advisor still needs to know", () => {
    it("asks for the skin type and the concerns when the profile is empty", () => {
      const intent = detectAdvisorIntent("hi");

      expect(intent.missing).toContain("SKIN_TYPE");
      expect(intent.missing).toContain("CONCERNS");
    });

    it("does not ask for the skin type when the profile already has it", () => {
      // Asking a customer for something they already told you is the
      // single most annoying thing a chat advisor can do.
      const intent = detectAdvisorIntent("hi", { skinType: "OILY" });

      expect(intent.missing).not.toContain("SKIN_TYPE");
      expect(intent.missing).toContain("CONCERNS");
    });

    it("asks for nothing when the profile is complete", () => {
      const intent = detectAdvisorIntent("hi", {
        skinType: "OILY",
        concerns: ["ACNE"],
      });

      expect(intent.missing).toEqual([]);
    });
  });

  describe("determinism", () => {
    it("returns the same intent for the same message", () => {
      const first = detectAdvisorIntent("my skin is oily and breaking out");
      const second = detectAdvisorIntent("my skin is oily and breaking out");

      expect(second).toEqual(first);
    });
  });
});

/**
 * ── The conflict-warning gate ─────────────────────────────────────────────
 *
 * The bug this exists to prevent: a customer who typed "hi" was shown a
 * "Use with care" panel about a retinol they had never mentioned, because
 * the conflict list is built from their **cart** and was therefore
 * identical on every turn.
 *
 * The gate is `mayWarn`, and it is deliberately *not* the same flag as
 * `mayRecommend`. A question may recommend without warning — "how do I
 * use retinol?" deserves a suggestion, not a warning about their
 * sunscreen. A question about combining products is the case where a
 * warning is exactly the answer: "can I use retinol with my sunscreen?"
 */
describe("mayWarn", () => {
  it("is false on a greeting", () => {
    expect(detectAdvisorIntent("hello").mayWarn).toBe(false);
  });

  it("is false on an order question", () => {
    expect(detectAdvisorIntent("where is my order?").mayWarn).toBe(false);
  });

  it("is false on a casual, non-skincare message", () => {
    // The exact shape of the reported bug: a general, empathetic reply
    // with no product recommendation, and no conflict card.
    for (const message of [
      "I had a bad day at work",
      "I had a rough day at work, thank you for the help",
      "thanks, that is helpful",
      "my dog is sick",
      "hmm okay",
      "can you sing a song for me",
    ]) {
      expect(detectAdvisorIntent(message).mayWarn).toBe(false);
    }
  });

  it("is false when a preposition appears without a product word", () => {
    // "with my" and "with the" are ordinary English. "I am with my
    // family" and "thank you with the help" are not questions about a
    // routine, and a preposition alone must not turn them into one.
    for (const message of [
      "I am with my family",
      "what happened with my order",
      "thank you with the help",
    ]) {
      expect(detectAdvisorIntent(message).mayWarn).toBe(false);
    }
  });

  it("is false on a colloquial use of a skin word", () => {
    // "rough" on its own is the everyday adjective. Only "rough skin"
    // is a complaint about a complexion.
    const intent = detectAdvisorIntent("I had a rough day at work");

    expect(intent.kind).not.toBe("CONCERN");
  });

  it("is still true on a complaint about rough skin", () => {
    const intent = detectAdvisorIntent("my skin is rough");

    expect(intent.kind).toBe("CONCERN");
    expect(intent.mayWarn).toBe(true);
  });

  it("is true on a concern, where a routine is on the table", () => {
    expect(detectAdvisorIntent("my skin is oily").mayWarn).toBe(true);
  });

  it("is true when a photo is attached", () => {
    expect(detectAdvisorIntent("hi", { hasImage: true }).mayWarn).toBe(true);
  });

  it("is false on a plain usage question", () => {
    // "How do I use retinol?" asks about application, not about pairing.
    // A warning here would be an answer to a question nobody asked.
    expect(detectAdvisorIntent("how do I use retinol?").mayWarn).toBe(false);
  });

  it("is false on a question about what a product is", () => {
    expect(detectAdvisorIntent("what is niacinamide?").mayWarn).toBe(false);
  });

  it("is true on a question about combining products", () => {
    // This is the case where a conflict warning *is* the answer.
    for (const message of [
      "can I use this with my sunscreen?",
      "can I use this with the sunscreen?",
      "can I use retinol with my serum",
      "what can I layer together?",
      "can I use these at the same time",
      "can I use both my cream and my serum?",
    ]) {
      expect(detectAdvisorIntent(message).mayWarn).toBe(true);
    }
  });

  it("is true on a Bengali question about combining products", () => {
    expect(detectAdvisorIntent("সাথে ব্যবহার করা যাবে?").mayWarn).toBe(true);
  });
});

describe("describeAdvisorIntent", () => {
  it("tells the model that a greeting carries no products", () => {
    const text = describeAdvisorIntent(GREETING_INTENT);

    expect(text).toContain("GREETING");
    expect(text).toContain("Recommend nothing on this turn");
    expect(text).toContain("skin type");
  });

  it("tells the model to answer a question before recommending", () => {
    const text = describeAdvisorIntent({
      kind: "QUESTION",
      mayRecommend: true,
      mayWarn: false,
      missing: [],
    });

    expect(text).toContain("QUESTION");
    expect(text).toContain("answer that question first");
  });

  it("tells the model an order question carries no products", () => {
    const text = describeAdvisorIntent({
      kind: "ORDER",
      mayRecommend: false,
      mayWarn: false,
      missing: [],
    });

    expect(text).toContain("ORDER");
    expect(text).toContain("Recommend nothing on this turn");
  });

  it("tells the model a concern is the turn to give advice on", () => {
    const text = describeAdvisorIntent({
      kind: "CONCERN",
      mayRecommend: true,
      mayWarn: true,
      missing: ["SKIN_TYPE"],
    });

    expect(text).toContain("CONCERN");
    expect(text).toContain("at most three");
  });

  it("forbids conflict warnings on a turn that may not warn", () => {
    // The prompt-side half of the gate. The response-side half is in the
    // service layer; both are needed, because the model can leak the
    // conflict into **prose** even when the card is suppressed.
    const text = describeAdvisorIntent({
      kind: "QUESTION",
      mayRecommend: true,
      mayWarn: false,
      missing: [],
    });

    expect(text).toContain("Do NOT mention any ingredient conflict");
    expect(text).toContain("unsolicited conflict warning is noise");
  });

  it("permits conflict warnings on a turn that may warn", () => {
    const text = describeAdvisorIntent({
      kind: "QUESTION",
      mayRecommend: true,
      mayWarn: true,
      missing: [],
    });

    expect(text).toContain("You may mention an ingredient conflict");
  });
});
