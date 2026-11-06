import { describe, expect, it } from "vitest";

import {
  advisorConversationIdSchema,
  advisorHistorySchema,
  advisorMessageSchema,
  catalogueConcernsSchema,
  concernsSchema,
  conversationListQuerySchema,
  MAX_CLIENT_HISTORY_TURNS,
  MAX_CONCERNS,
  MAX_CONVERSATION_LIMIT,
  MAX_MESSAGES_PER_HOUR,
  MAX_MESSAGE_LENGTH,
  MAX_NOTES_LENGTH,
  PROFILE_PHOTO_MAX_BYTES,
  saveAsProfilePhotoSchema,
  SKIN_CONCERNS,
  skinTypeSchema,
  updateAdvisorConfigSchema,
  updateProfileSchema,
} from "@/lib/validation/advisor";

/**
 * The advisor's validation vocabulary.
 *
 * These are the rules at the boundary — the point where a request
 * becomes a database row. Each test here corresponds to a specific way
 * the boundary could be breached.
 */

describe("advisorMessageSchema", () => {
  it("accepts a normal message", () => {
    expect(advisorMessageSchema.parse("My skin is oily.")).toBe(
      "My skin is oily.",
    );
  });

  it("trims the message", () => {
    expect(advisorMessageSchema.parse("  hello  ")).toBe("hello");
  });

  it("rejects an empty message", () => {
    expect(() => advisorMessageSchema.parse("   ")).toThrow();
  });

  it("rejects a message over the length cap", () => {
    const tooLong = "a".repeat(MAX_MESSAGE_LENGTH + 1);

    expect(() => advisorMessageSchema.parse(tooLong)).toThrow();
  });

  it("accepts a message exactly at the cap", () => {
    const atCap = "a".repeat(MAX_MESSAGE_LENGTH);

    expect(advisorMessageSchema.parse(atCap).length).toBe(MAX_MESSAGE_LENGTH);
  });
});

describe("advisorConversationIdSchema", () => {
  it("accepts an id", () => {
    expect(advisorConversationIdSchema.parse("abc123")).toBe("abc123");
  });

  it("rejects an empty id", () => {
    expect(() => advisorConversationIdSchema.parse("")).toThrow();
  });

  it("rejects an id over 64 characters", () => {
    expect(() => advisorConversationIdSchema.parse("a".repeat(65))).toThrow();
  });

  it("is optional", () => {
    expect(advisorConversationIdSchema.parse(undefined)).toBeUndefined();
  });
});

describe("saveAsProfilePhotoSchema", () => {
  it("accepts the boolean true", () => {
    expect(saveAsProfilePhotoSchema.parse(true)).toBe(true);
  });

  it("accepts the string 'true'", () => {
    expect(saveAsProfilePhotoSchema.parse("true")).toBe(true);
  });

  it("accepts the string 'false'", () => {
    expect(saveAsProfilePhotoSchema.parse("false")).toBe(false);
  });

  it("rejects anything else", () => {
    expect(() => saveAsProfilePhotoSchema.parse("yes")).toThrow();
  });
});

describe("skinTypeSchema", () => {
  it("accepts every value in the Prisma enum", () => {
    const values = [
      "NORMAL",
      "DRY",
      "OILY",
      "COMBINATION",
      "SENSITIVE",
      "ACNE_PRONE",
      "UNKNOWN",
    ] as const;

    for (const value of values) {
      expect(skinTypeSchema.parse(value)).toBe(value);
    }
  });

  it("rejects a value that is not in the enum", () => {
    expect(() => skinTypeSchema.parse("SUPER_OILY")).toThrow();
  });
});

describe("the concern catalogues", () => {
  it("has a closed list of concerns", () => {
    expect(SKIN_CONCERNS.length).toBeGreaterThan(0);
  });

  it("rejects a concern that is not in the catalogue", () => {
    expect(() => catalogueConcernsSchema.parse(["NOT_A_CONCERN"])).toThrow();
  });

  it("accepts a concern that is in the catalogue", () => {
    expect(catalogueConcernsSchema.parse(["ACNE", "DULLNESS"])).toEqual([
      "ACNE",
      "DULLNESS",
    ]);
  });

  it("caps the number of catalogue concerns", () => {
    expect(() =>
      catalogueConcernsSchema.parse(
        Array.from({ length: MAX_CONCERNS + 1 }, () => "ACNE"),
      ),
    ).toThrow();
  });

  it("allows the free-text concern list to be empty by default", () => {
    expect(concernsSchema.parse(undefined)).toEqual([]);
  });
});

describe("updateProfileSchema", () => {
  it("accepts a valid body", () => {
    const result = updateProfileSchema.parse({
      skinType: "OILY",
      concerns: ["OILINESS"],
      notes: "I use a foaming cleanser.",
      smsOptIn: true,
    });

    expect(result.skinType).toBe("OILY");
    expect(result.smsOptIn).toBe(true);
  });

  it("rejects notes over the cap", () => {
    expect(() =>
      updateProfileSchema.parse({ notes: "a".repeat(MAX_NOTES_LENGTH + 1) }),
    ).toThrow();
  });

  it("rejects a past estimated-empty date", () => {
    // A reminder for a product that already ran out is not a reminder.
    const past = new Date(Date.now() - 60_000).toISOString();

    expect(() =>
      updateProfileSchema.parse({ estimatedEmptyAt: past }),
    ).toThrow();
  });

  it("rejects a malformed estimated-empty date", () => {
    expect(() =>
      updateProfileSchema.parse({ estimatedEmptyAt: "not-a-date" }),
    ).toThrow();
  });

  it("accepts a future estimated-empty date", () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    expect(updateProfileSchema.parse({ estimatedEmptyAt: future })).toBeTruthy();
  });

  it("accepts null to clear the estimated-empty date", () => {
    expect(
      updateProfileSchema.parse({ estimatedEmptyAt: null }).estimatedEmptyAt,
    ).toBeNull();
  });
});

describe("conversationListQuerySchema", () => {
  it("defaults the limit", () => {
    expect(conversationListQuerySchema.parse({}).limit).toBe(20);
  });

  it("coerces a string limit", () => {
    expect(conversationListQuerySchema.parse({ limit: "5" }).limit).toBe(5);
  });

  it("rejects a limit over the cap", () => {
    expect(() =>
      conversationListQuerySchema.parse({ limit: MAX_CONVERSATION_LIMIT + 1 }),
    ).toThrow();
  });

  it("rejects a limit below one", () => {
    expect(() => conversationListQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it("rejects a non-numeric limit", () => {
    expect(() => conversationListQuerySchema.parse({ limit: "many" })).toThrow();
  });
});

describe("updateAdvisorConfigSchema", () => {
  it("rejects an empty disclaimer", () => {
    expect(() =>
      updateAdvisorConfigSchema.parse({ disclaimerText: "" }),
    ).toThrow();
  });

  it("rejects a whitespace-only disclaimer", () => {
    expect(() =>
      updateAdvisorConfigSchema.parse({ disclaimerText: "   " }),
    ).toThrow();
  });

  it("accepts a real disclaimer", () => {
    const result = updateAdvisorConfigSchema.parse({
      disclaimerText: "This is a suggestion, not a prescription.",
    });

    expect(result.disclaimerText.length).toBeGreaterThan(0);
  });

  it("caps the allow-list length", () => {
    expect(() =>
      updateAdvisorConfigSchema.parse({
        disclaimerText: "A disclaimer.",
        aiProductIds: Array.from({ length: 501 }, (_, i) => `p${i}`),
      }),
    ).toThrow();
  });
});

describe("the limits", () => {
  it("caps the hourly message count", () => {
    expect(MAX_MESSAGES_PER_HOUR).toBe(20);
  });

  it("caps the image size", () => {
    expect(PROFILE_PHOTO_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("advisorHistorySchema", () => {
  it("accepts a well-formed transcript", () => {
    const parsed = advisorHistorySchema.parse([
      { role: "USER", content: "Hi" },
      { role: "ASSISTANT", content: "Hello! What is your skin type?" },
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.role).toBe("USER");
  });

  it("accepts an empty transcript", () => {
    expect(advisorHistorySchema.parse([])).toEqual([]);
  });

  it("rejects a turn with an unknown role", () => {
    expect(() =>
      advisorHistorySchema.parse([{ role: "SYSTEM", content: "Be brief." }]),
    ).toThrow();
  });

  it("rejects a turn with no content", () => {
    expect(() =>
      advisorHistorySchema.parse([{ role: "USER", content: "" }]),
    ).toThrow();
  });

  it("rejects a turn with whitespace-only content", () => {
    expect(() =>
      advisorHistorySchema.parse([{ role: "USER", content: "   " }]),
    ).toThrow();
  });

  it("strips a turn's extra fields rather than passing them on", () => {
    // The client may send more than the server needs — a UI state flag,
    // a timestamp. Zod drops the unknown keys, so nothing the client
    // invents ever reaches the prompt.
    const parsed = advisorHistorySchema.parse([
      { role: "USER", content: "Hi", isPending: true, createdAt: "2026-01-01" },
    ]);

    expect(parsed[0]).toEqual({ role: "USER", content: "Hi" });
    expect(Object.keys(parsed[0] ?? {})).toHaveLength(2);
  });

  it("caps the number of turns", () => {
    const turns = Array.from({ length: MAX_CLIENT_HISTORY_TURNS + 1 }, () => ({
      role: "USER",
      content: "Hi",
    }));

    expect(() => advisorHistorySchema.parse(turns)).toThrow();
  });

  it("accepts a transcript at the cap", () => {
    const turns = Array.from({ length: MAX_CLIENT_HISTORY_TURNS }, () => ({
      role: "USER",
      content: "Hi",
    }));

    expect(advisorHistorySchema.parse(turns)).toHaveLength(
      MAX_CLIENT_HISTORY_TURNS,
    );
  });

  it("rejects a turn that is too long", () => {
    expect(() =>
      advisorHistorySchema.parse([
        { role: "USER", content: "a".repeat(MAX_MESSAGE_LENGTH + 1) },
      ]),
    ).toThrow();
  });
});
