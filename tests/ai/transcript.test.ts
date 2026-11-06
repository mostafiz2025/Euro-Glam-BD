import { describe, expect, it } from "vitest";

import {
  appendAnswer,
  removeFailedTurn,
  turnIds,
  turnsForHistory,
  type TranscriptMessage,
} from "@/lib/ai/transcript";

/**
 * The advisor's transcript mutations.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The chat's `messages` array is the thing the customer reads. It went
 * wrong twice, in ways that were invisible in review and invisible in
 * the UI until a customer hit them:
 *
 *   1. The customer's own message was **deleted** when the answer
 *      arrived. The customer typed "my skin is oily", pressed send, and
 *      watched their own words disappear, replaced by the reply.
 *
 *   2. The "thinking" bubble was **orphaned**. It had its own id, and
 *      the success path filtered on the *customer's* id, so the bubble
 *      stayed on screen for the rest of the conversation — permanently
 *      "thinking".
 *
 * These tests pin both behaviours down, plus the third property the
 * component needs: switching conversations must reset the transcript.
 */

/**
 * A message in a test transcript.
 */
type Message = TranscriptMessage;

/**
 * Builds a customer message.
 */
function user(content: string, id = "local-1"): Message {
  return {
    id,
    role: "USER",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Builds an assistant message.
 */
function assistant(content: string, id = "msg-1"): Message {
  return {
    id,
    role: "ASSISTANT",
    content,
    createdAt: "2026-01-01T00:00:01.000Z",
  };
}

/**
 * Builds the "thinking" bubble.
 */
function pending(id: string): Message {
  return {
    id,
    role: "ASSISTANT",
    content: "",
    createdAt: "2026-01-01T00:00:00.500Z",
    isPending: true,
  };
}

describe("turnIds", () => {
  it("gives the pending bubble its own id", () => {
    const ids = turnIds("local-1");

    expect(ids.optimisticId).toBe("local-1");
    expect(ids.pendingId).toBe("local-1-reply");
  });

  it("never gives the pending bubble the customer's id", () => {
    // The whole orphaning bug hinged on this: if the two ids were the
    // same, removing one would remove both.
    const ids = turnIds("local-1");

    expect(ids.pendingId).not.toBe(ids.optimisticId);
  });

  it("gives two turns different ids", () => {
    expect(turnIds("local-1").pendingId).not.toBe(
      turnIds("local-2").pendingId,
    );
  });
});

describe("appendAnswer", () => {
  const ids = turnIds("local-1");

  it("keeps the customer's message", () => {
    // The regression. The customer's own words must survive the answer.
    const messages = [user("my skin is oily"), pending(ids.pendingId)];

    const result = appendAnswer(messages, ids, assistant("Try this serum."));

    expect(result.map((message) => message.id)).toContain("local-1");
  });

  it("puts the answer after the customer's message", () => {
    const messages = [user("my skin is oily"), pending(ids.pendingId)];

    const result = appendAnswer(messages, ids, assistant("Try this serum."));

    expect(result.map((message) => message.role)).toEqual([
      "USER",
      "ASSISTANT",
    ]);
    expect(result[0]?.content).toBe("my skin is oily");
    expect(result[1]?.content).toBe("Try this serum.");
  });

  it("removes the pending bubble", () => {
    // The other regression. The "thinking" bubble used to stay forever.
    const messages = [user("my skin is oily"), pending(ids.pendingId)];

    const result = appendAnswer(messages, ids, assistant("Try this serum."));

    expect(result.map((message) => message.id)).not.toContain(ids.pendingId);
  });

  it("leaves no pending bubble behind", () => {
    const messages = [user("my skin is oily"), pending(ids.pendingId)];

    const result = appendAnswer(messages, ids, assistant("Try this serum."));

    expect(result.filter((message) => message.isPending)).toEqual([]);
  });

  it("keeps the earlier turns of the conversation", () => {
    const messages = [
      user("hi", "local-0"),
      assistant("Hello!", "msg-0"),
      user("my skin is oily", "local-1"),
      pending(ids.pendingId),
    ];

    const result = appendAnswer(messages, ids, assistant("Try this serum."));

    expect(result.map((message) => message.id)).toEqual([
      "local-0",
      "msg-0",
      "local-1",
      "msg-1",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const messages = [user("my skin is oily"), pending(ids.pendingId)];

    appendAnswer(messages, ids, assistant("Try this serum."));

    expect(messages).toHaveLength(2);
  });

  it("appends the answer even when there was no pending bubble", () => {
    // Defensive: a turn whose pending bubble was already removed still
    // has to show the answer.
    const result = appendAnswer(
      [user("my skin is oily")],
      ids,
      assistant("Try this serum."),
    );

    expect(result).toHaveLength(2);
  });
});

describe("removeFailedTurn", () => {
  const ids = turnIds("local-1");

  it("removes the customer's message", () => {
    // The turn never happened, so the message must not stay on screen.
    const messages = [user("my skin is oily"), pending(ids.pendingId)];

    const result = removeFailedTurn(messages, ids);

    expect(result).toEqual([]);
  });

  it("removes the pending bubble", () => {
    // The old code removed only the customer's id, which left the
    // "thinking" bubble orphaned on screen.
    const messages = [user("my skin is oily"), pending(ids.pendingId)];

    const result = removeFailedTurn(messages, ids);

    expect(result.filter((message) => message.isPending)).toEqual([]);
  });

  it("keeps the earlier turns of the conversation", () => {
    const messages = [
      user("hi", "local-0"),
      assistant("Hello!", "msg-0"),
      user("my skin is oily", "local-1"),
      pending(ids.pendingId),
    ];

    const result = removeFailedTurn(messages, ids);

    expect(result.map((message) => message.id)).toEqual([
      "local-0",
      "msg-0",
    ]);
  });

  it("does not remove another turn's bubbles", () => {
    // Two turns in flight is not possible in this UI, but the mutation
    // must not be able to reach across and delete a later turn.
    const other = turnIds("local-2");

    const messages = [
      user("first", "local-1"),
      pending(ids.pendingId),
      user("second", other.optimisticId),
      pending(other.pendingId),
    ];

    const result = removeFailedTurn(messages, ids);

    expect(result.map((message) => message.id)).toEqual([
      other.optimisticId,
      other.pendingId,
    ]);
  });

  it("does not mutate the array it was given", () => {
    const messages = [user("my skin is oily"), pending(ids.pendingId)];

    removeFailedTurn(messages, ids);

    expect(messages).toHaveLength(2);
  });
});

describe("turnsForHistory", () => {
  it("includes the customer's own message", () => {
    // The advisor has to see the whole conversation, including the turn
    // the database has not been told about yet.
    const turns = turnsForHistory([user("my skin is oily")]);

    expect(turns).toEqual([{ role: "USER", content: "my skin is oily" }]);
  });

  it("excludes the pending bubble", () => {
    // It has no content, and it is not part of the conversation.
    const turns = turnsForHistory([pending("local-1-reply")]);

    expect(turns).toEqual([]);
  });

  it("excludes a message with no content", () => {
    const turns = turnsForHistory([
      { ...user(""), id: "blank" },
    ]);

    expect(turns).toEqual([]);
  });

  it("excludes a message with only whitespace", () => {
    const turns = turnsForHistory([user("   ")]);

    expect(turns).toEqual([]);
  });

  it("keeps both roles, in order", () => {
    const turns = turnsForHistory([
      user("hi", "a"),
      assistant("Hello!", "b"),
      user("my skin is oily", "c"),
    ]);

    expect(turns.map((turn) => turn.role)).toEqual([
      "USER",
      "ASSISTANT",
      "USER",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const messages = [user("hi")];

    turnsForHistory(messages);

    expect(messages).toHaveLength(1);
  });
});
