/**
 * The advisor's transcript mutations.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * The chat component's `messages` array is the thing the customer reads.
 * It is also the thing that went wrong, twice, in ways that were hard to
 * see and hard to test:
 *
 *   1. The customer's own message was **deleted** when the answer
 *      arrived. The customer typed "my skin is oily", pressed send, and
 *      watched their own words disappear from the screen, replaced by
 *      the reply. It was the single most alarming thing a chat can do.
 *
 *   2. The "thinking" bubble was **orphaned**. It had its own id, and
 *      the success path filtered on the *customer's* id, so the bubble
 *      stayed on screen for the rest of the conversation — permanently
 *      "thinking".
 *
 * Both bugs lived inside a `setMessages((current) => ...)` callback in a
 * React component. Testing them meant mounting a component, which meant
 * a DOM, which meant a test stack this project does not have.
 *
 * So the mutations live here instead: pure functions over a plain
 * array. The component calls them; the tests assert on them directly.
 * The behaviour under test is the behaviour that ships, because there is
 * only one copy of it.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **The customer's message is never removed by a successful turn.**
 *
 * Only a *failed* turn removes it, because a failed turn means the
 * message was never sent. A successful turn appends the answer after it
 * and leaves everything before it alone.
 */

/**
 * One message in the local transcript.
 *
 * The base shape — the fields every transcript message has. The
 * component's own `LocalMessage` extends it with the recommendation
 * and conflict payloads, so the mutations below are generic over the
 * message type and return exactly what went in.
 */
export type TranscriptMessage = {
  readonly id: string;
  readonly role: "USER" | "ASSISTANT";
  readonly content: string;
  readonly createdAt: string;
  readonly isMocked?: boolean;
  readonly isPending?: boolean;
  readonly recommendations?: readonly unknown[];
  readonly conflicts?: readonly unknown[];
  readonly images?: ReadonlyArray<{
    readonly id: string;
    readonly url: string;
    readonly mimeType: string;
  }>;
};

/**
 * The ids of the two bubbles one turn creates.
 *
 * The pending bubble has its own id, deliberately. Removing it by its
 * own id is what keeps it from being confused with the customer's
 * message — and what stops it being orphaned.
 */
export type TurnIds = {
  /** The id of the customer's optimistic message. */
  readonly optimisticId: string;
  /** The id of the "thinking" bubble. */
  readonly pendingId: string;
};

/**
 * Builds the ids for one turn.
 *
 * The pending id is derived from the optimistic id so the two are
 * always related, but it is a **distinct** id — the component filters
 * on it separately.
 */
export function turnIds(optimisticId: string): TurnIds {
  return {
    optimisticId,
    pendingId: `${optimisticId}-reply`,
  };
}

/**
 * Removes the two bubbles of a turn that **failed**.
 *
 * The customer's message goes too, because the turn never happened —
 * leaving it on screen would show a message that was not sent next to
 * an error, which is exactly the state the customer is trying to
 * escape.
 *
 * The pending bubble goes as well. The old code removed only the
 * customer's id, which left the "thinking" bubble on screen forever.
 */
export function removeFailedTurn<T extends TranscriptMessage>(
  messages: readonly T[],
  ids: TurnIds,
): readonly T[] {
  return messages.filter(
    (message) =>
      message.id !== ids.optimisticId && message.id !== ids.pendingId,
  );
}

/**
 * Removes the pending bubble and appends the answer.
 *
 * The customer's message **stays**, and the answer lands after it. That
 * is the whole point: the customer must be able to read their own
 * question next to the answer to it.
 *
 * The pending bubble is removed by its own id, so the customer's message
 * cannot be mistaken for it.
 */
export function appendAnswer<T extends TranscriptMessage>(
  messages: readonly T[],
  ids: TurnIds,
  answer: T,
): readonly T[] {
  return [
    ...messages.filter((message) => message.id !== ids.pendingId),
    answer,
  ];
}

/**
 * The turns of the transcript, for the request's `history` field.
 *
 * The pending bubble is excluded — it has no content, and it is not
 * part of the conversation. The customer's own message **is** included,
 * because the advisor must see the whole transcript.
 *
 * The pending bubble is also excluded from the history because the
 * current message travels separately, in the `message` field. Sending
 * it twice would make the advisor answer a question it had already
 * answered.
 */
export function turnsForHistory(
  messages: readonly TranscriptMessage[],
): ReadonlyArray<{ role: "USER" | "ASSISTANT"; content: string }> {
  return messages
    .filter(
      (message) =>
        !message.isPending && message.content.trim().length > 0,
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}
