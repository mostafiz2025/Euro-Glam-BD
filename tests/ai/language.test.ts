import { describe, expect, it } from "vitest";

import {
  BANGLISH,
  BENGALI,
  ENGLISH,
  describeAdvisorLanguage,
  detectAdvisorLanguage,
} from "@/lib/ai/language";

/**
 * The advisor's language detection.
 *
 * ── What these tests are really about ─────────────────────────────────────
 *
 * The advisor is used in Dhaka, and a customer who writes in Bengali
 * must be answered in Bengali. The detection is done in code rather
 * than left to the model because:
 *
 *   1. It has to be **deterministic** — the same message must always
 *      be detected the same way.
 *   2. It has to be **safe** — a false positive sends an English
 *      question to a model told to answer in Bengali, and the customer
 *      gets an answer in a language they did not use.
 *
 * So the tests below are mostly about the *negative* cases: the
 * English messages that must NOT be read as Banglish. Those are the
 * ones that would actually hurt.
 */
describe("detectAdvisorLanguage", () => {
  describe("English", () => {
    it("reads a plain English question as English", () => {
      const result = detectAdvisorLanguage(
        "What is the best cleanser for oily skin?",
      );

      expect(result.code).toBe("en");
      expect(result.isBanglish).toBe(false);
    });

    it("reads a message with no words as English", () => {
      expect(detectAdvisorLanguage("").code).toBe("en");
      expect(detectAdvisorLanguage("   ").code).toBe("en");
      expect(detectAdvisorLanguage("12345 !!!").code).toBe("en");
    });

    /**
     * The catalogue's own vocabulary.
     *
     * These are the words that appear in **every** message about this
     * shop — "pore", "use", "face", "skin", "serum". A vocabulary
     * that included them would misfire on ordinary English, so they
     * are deliberately excluded.
     */
    it("does not read the catalogue's own vocabulary as Banglish", () => {
      const messages = [
        "I have large pores and oily skin. Which serum should I use?",
        "My face is very sensitive and I want a gentle cleanser.",
        "Can I use this retinol with my acne cream?",
        "What is the best sunscreen for acne prone skin in Bangladesh?",
      ];

      for (const message of messages) {
        expect(detectAdvisorLanguage(message).code).toBe("en");
      }
    });

    it("does not read a long English message with one Bangla word as Banglish", () => {
      const result = detectAdvisorLanguage(
        "My skin is very oily in the afternoon and I would like to know which moisturizer works best for acne prone skin during the humid season here",
      );

      expect(result.code).toBe("en");
    });
  });

  describe("Bengali script", () => {
    it("reads the Bangla script as Bengali", () => {
      const result = detectAdvisorLanguage("আমার ত্বকে অনেক ব্রণ হয়");

      expect(result.code).toBe("bn");
      expect(result.isBanglish).toBe(false);
    });

    it("reads a Bengali sentence with English product names as Bengali", () => {
      const result = detectAdvisorLanguage(
        "আমার ত্বকে CeraVe cleanser ভালো কাজ করে, কিন্তু Retinol ব্যবহার করবো কি?",
      );

      expect(result.code).toBe("bn");
      expect(result.isBanglish).toBe(false);
    });

    it("reads a single Bangla character as Bengali", () => {
      expect(detectAdvisorLanguage("আ").code).toBe("bn");
    });
  });

  describe("Banglish", () => {
    it("reads Bengali in Latin script as Banglish", () => {
      const result = detectAdvisorLanguage(
        "amar skin er onek problem ache, kivabe use korbo?",
      );

      expect(result.code).toBe("bn");
      expect(result.isBanglish).toBe(true);
    });

    it("reads a longer Banglish message as Banglish", () => {
      const result = detectAdvisorLanguage(
        "amar skin onek oily hoye jay, acne o ache. ki sunscreen nibo?",
      );

      expect(result.code).toBe("bn");
      expect(result.isBanglish).toBe(true);
    });

    it("does not read a single Bangla word as Banglish", () => {
      // One match is not enough: near-misses like "no", "na" and "hot"
      // turn up in English messages often enough that a single hit
      // would misfire regularly.
      const result = detectAdvisorLanguage(
        "I would like to use a gentle cleanser for my skin, please advise",
      );

      expect(result.code).toBe("en");
    });
  });
});

describe("describeAdvisorLanguage", () => {
  it("describes English", () => {
    const text = describeAdvisorLanguage(ENGLISH);

    expect(text).toContain("English");
  });

  it("describes Bengali in the Bangla script", () => {
    const text = describeAdvisorLanguage(BENGALI);

    expect(text).toContain("Bengali");
    expect(text).toContain("Bangla script");
  });

  it("describes Banglish and tells the model to keep product names in English", () => {
    const text = describeAdvisorLanguage(BANGLISH);

    expect(text).toContain("Banglish");
    expect(text).toContain("English");
  });

  it("always tells the model to keep product and ingredient names in English", () => {
    // This is the part that must not be lost: a Bangla answer that
    // translates "CeraVe" into Bangla is less useful than one that
    // leaves it alone.
    for (const language of [ENGLISH, BENGALI, BANGLISH]) {
      expect(describeAdvisorLanguage(language)).toContain("English");
    }
  });
});
