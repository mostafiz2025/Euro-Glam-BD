"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { CloseIcon, SparkleIcon } from "@/components/ui/icons";
import {
  appendAnswer,
  removeFailedTurn,
  turnIds,
  turnsForHistory,
  type TranscriptMessage,
} from "@/lib/ai/transcript";

import { DisclaimerBanner } from "./DisclaimerBanner";
import { MessageBubble } from "./MessageBubble";

import type {
  AdvisorChatResult,
  AdvisorConflict,
  AdvisorConversationMessage,
  AdvisorConversationSummary,
  AdvisorDisclaimer,
  AdvisorRecommendation,
} from "@/lib/format/types";

/**
 * The advisor chat.
 *
 * ── The rules that govern this file ──────────────────────────────────────
 *
 * **1. The disclaimer is always visible.**
 *
 * It sits above the transcript, outside the scroll area, and never
 * scrolls away. It is fetched from `/api/advisor/config` on mount — the
 * banner has to be there *before* the first message, not only after an
 * answer arrives.
 *
 * **2. The response envelope is checked, not assumed.**
 *
 * Every call discriminates on `ok` first. A client that reads
 * `payload.data` without checking will throw a `TypeError` on an error
 * response, and the customer sees "cannot read properties of undefined"
 * instead of the actual message.
 *
 * **3. A pending turn is not duplicated.**
 *
 * The send button is disabled while a request is in flight, and the
 * `isPending` state is the single source of truth for that. Two rapid
 * Enter presses therefore produce one request, not two — a double-sent
 * message burns two provider calls and two rate-limit slots.
 *
 * **4. The customer's own message stays in the transcript.**
 *
 * The customer's bubble appears the moment they send, and it **stays**
 * there when the answer arrives. It used to be removed and replaced by
 * the assistant's reply, which meant the customer sent "my skin is
 * oily" and watched their own message vanish from the screen — the
 * single most alarming thing a chat can do. The server persists it, but
 * the server is not what the customer is looking at.
 *
 * The answer is **appended** after the pending bubble, and the pending
 * bubble is removed by its own id. Both are addressed by id, so neither
 * can be confused with the other.
 *
 * **5. Switching conversations resets the transcript.**
 *
 * `useState` only reads its initial value on the **first** render, so a
 * component that is *reconciled* keeps the old conversation's messages
 * on screen under the new one's title.
 *
 * The fix is the `key` on the component in `page.tsx`: it is the
 * conversation id, so opening a different conversation **mounts a
 * different component instance** with the new transcript, rather than
 * reconciling the old one against the new props.
 *
 * A `key` is used rather than an effect that resets the state, because
 * an effect that calls `setState` synchronously causes a cascading
 * render — and because the remount is what makes the reset *complete*:
 * the draft, the attachment, the error and the pending flag all reset
 * with the transcript, without any of them having to be listed.
 */
export type AdvisorChatProps = {
  /** The conversation to open. Null starts a new one. */
  readonly conversationId: string | null;
  /** The messages already in the conversation, oldest first. */
  readonly initialMessages: readonly AdvisorConversationMessage[];
  /** The conversations the customer has, newest first. */
  readonly conversations: readonly AdvisorConversationSummary[];
  /** The disclaimer to show. */
  readonly disclaimer: AdvisorDisclaimer;
};

/**
 * A message in the local transcript, before the server has confirmed it.
 *
 * Extends the shared `TranscriptMessage` so the transcript mutations in
 * `@/lib/ai/transcript` can be applied to it without a cast — and so
 * the behaviour under test is the behaviour that ships.
 */
type LocalMessage = TranscriptMessage & {
  readonly recommendations?: readonly AdvisorRecommendation[];
  readonly conflicts?: readonly AdvisorConflict[];
};

export function AdvisorChat({
  conversationId,
  initialMessages,
  conversations,
  disclaimer,
}: AdvisorChatProps) {
  const [messages, setMessages] = useState<readonly LocalMessage[]>(
    initialMessages,
  );
  const [draft, setDraft] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(conversationId);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── The scroll behaviour ───────────────────────────────────────────────
  //
  // The transcript scrolls to the newest message whenever the list
  // changes. The scroll is a DOM effect on an external thing (the
  // scroll position), not a state update, so it belongs in an effect.
  useEffect(() => {
    const node = transcriptRef.current;

    if (!node) return;

    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // ── The textarea grows with its content ────────────────────────────────
  //
  // Capped at a maximum height. Beyond that the transcript scrolls, not
  // the composer — a composer that grows without bound pushes the
  // transcript off the screen on a phone.
  useEffect(() => {
    const node = textareaRef.current;

    if (!node) return;

    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
  }, [draft]);

  const send = useCallback(async () => {
    const text = draft.trim();

    // An empty turn costs a provider call and burns a rate-limit slot.
    // The button is also disabled in this case, but the guard is repeated
    // here because the Enter key can bypass the button entirely.
    if ((text.length === 0 && attachment === null) || isPending) {
      return;
    }

    const optimisticId = `local-${Date.now()}`;

    // The pending bubble has its own id, so it can be removed without
    // touching the customer's message. It used to be derived inline and
    // never removed by id, which orphaned it permanently.
    const ids = turnIds(optimisticId);

    const optimistic: LocalMessage = {
      id: ids.optimisticId,
      role: "USER",
      content: text || "(a photo was attached)",
      createdAt: new Date().toISOString(),
    };

    const pendingReply: LocalMessage = {
      id: ids.pendingId,
      role: "ASSISTANT",
      content: "",
      createdAt: new Date().toISOString(),
      isPending: true,
    };

    /*
     * The transcript, as the client holds it.
     *
     * The server can read the conversation from the database, and it
     * does. But the client knows the transcript *now* — including the
     * message the customer has just sent, which the database has not
     * been told about yet. Sending it means the advisor always has the
     * whole conversation in front of it, even on the turn where the
     * stored transcript is one turn behind.
     *
     * The turns sent are the ones **before** this message — the current
     * message travels as the `message` field, and the server reads the
     * history as the past.
     */
    const history = turnsForHistory(messages);

    setMessages((current) => [...current, optimistic, pendingReply]);
    setDraft("");
    setAttachment(null);
    setError(null);
    setIsPending(true);

    const form = new FormData();
    form.set("message", text);

    if (attachment) {
      form.set("image", attachment);
    }

    if (activeConversationId) {
      form.set("conversationId", activeConversationId);
    }

    if (history.length > 0) {
      form.set("history", JSON.stringify(history));
    }

    try {
      const response = await fetch("/api/advisor/chat", {
        method: "POST",
        body: form,
      });

      const payload = (await response.json()) as {
        ok: boolean;
        data?: AdvisorChatResult;
        error?: { message: string };
      };

      if (!payload.ok || !payload.data) {
        // The optimistic turn is removed — it never happened. Leaving it
        // would show the customer a message that was not sent and an
        // error, which is exactly the state they are trying to escape.
        setMessages((current) => removeFailedTurn(current, ids));
        setError(payload.error?.message ?? "That did not go through.");
        return;
      }

      const result = payload.data;

      setActiveConversationId(result.conversationId);

      // The customer's own message **stays**. The answer is appended
      // after it. The old code filtered the optimistic bubble out and
      // replaced it with the reply, so the customer watched their own
      // message vanish the moment the advisor answered.
      setMessages((current) =>
        appendAnswer(current, ids, {
          id: result.message.id,
          role: "ASSISTANT",
          content: result.message.content,
          createdAt: result.message.createdAt,
          isMocked: result.provider.isMocked,
          recommendations: result.recommendations,
          conflicts: result.conflicts,
        }),
      );
    } catch {
      setMessages((current) => removeFailedTurn(current, ids));
      setError("We could not reach the advisor. Please check your connection.");
    } finally {
      setIsPending(false);
    }
  }, [activeConversationId, attachment, draft, isPending, messages]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a newline. The check is on the key
    // *and* the absence of a modifier, so Shift+Enter is not swallowed.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function pickFile() {
    fileInputRef.current?.click();
  }

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      setAttachment(null);
      return;
    }

    // The client-side check is a courtesy, not a control. The server
    // validates the bytes again — the magic-byte check there is the one
    // that counts, because the client can be lying.
    if (file.size > 5 * 1024 * 1024) {
      setError("That photo is larger than 5 MB. Please choose a smaller one.");
      event.target.value = "";
      return;
    }

    setAttachment(file);
    setError(null);
  }

  function clearAttachment() {
    setAttachment(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── The conversation history ─────────────────────────────────── */}
      {/* The customer's past conversations, so they can pick up where they
          left off. Hidden on small screens — the chat is the priority
          there, and the history is one scroll away on a larger screen. */}
      {conversations.length > 0 ? (
        <div className="hidden border-b border-border px-4 py-3 lg:block">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Recent conversations
          </p>

          <ul className="mt-2 flex flex-wrap gap-2">
            {conversations.slice(0, 6).map((conversation) => (
              <li key={conversation.id}>
                <Link
                  href={`/advisor?conversationId=${conversation.id}`}
                  className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-foreground-muted transition-colors hover:border-brand-300 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <span className="truncate">
                    {conversation.title ?? "New conversation"}
                  </span>
                  <span className="shrink-0 text-foreground-muted">
                    {conversation.messageCount}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── The disclaimer ─────────────────────────────────────────────── */}
      {/* Always visible. Never dismissible. See DisclaimerBanner. */}
      <div className="px-4 pt-4">
        <DisclaimerBanner text={disclaimer.text} version={disclaimer.version} />
      </div>

      {/* ── The transcript ─────────────────────────────────────────────── */}
      <div
        ref={transcriptRef}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5"
        role="log"
        aria-label="Advisor conversation"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((message) =>
            message.isPending ? (
              <ThinkingBubble key={message.id} />
            ) : (
              <MessageBubble
                key={message.id}
                role={message.role}
                content={message.content}
                createdAt={message.createdAt}
                isMocked={message.isMocked ?? false}
                recommendations={message.recommendations ?? []}
                conflicts={message.conflicts ?? []}
                images={message.images ?? []}
              />
            ),
          )
        )}
      </div>

      {/* ── The error ─────────────────────────────────────────────────── */}
      {error ? (
        <p
          role="alert"
          className="mx-4 mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </p>
      ) : null}

      {/* ── The composer ──────────────────────────────────────────────── */}
      <div className="sticky bottom-0 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
        {attachment ? (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-xl bg-surface-muted px-3 py-2">
            <span className="min-w-0 truncate text-xs text-foreground-muted">
              {attachment.name}
            </span>

            <button
              type="button"
              onClick={clearAttachment}
              aria-label="Remove the attached photo"
              className="shrink-0 rounded-full p-1 text-foreground-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <CloseIcon width={14} height={14} />
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onFileChange}
            className="sr-only"
            aria-label="Attach a photo"
          />

          <button
            type="button"
            onClick={pickFile}
            aria-label="Attach a photo"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-foreground-muted transition-colors hover:border-brand-300 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={2000}
            placeholder="Ask about your skin…"
            aria-label="Your message to the advisor"
            className="min-h-11 flex-1 resize-none rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />

          <Button
            onClick={() => void send()}
            disabled={
              isPending || (draft.trim().length === 0 && attachment === null)
            }
            aria-label="Send your message"
            className="h-11 w-11 shrink-0 rounded-full p-0"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
          </Button>
        </div>

        <p className="mt-2 text-[11px] text-foreground-muted">
          Enter to send · Shift + Enter for a new line
        </p>
      </div>
    </div>
  );
}

/**
 * The empty state.
 *
 * It says what the advisor is for. An empty transcript with no prompt
 * gives the customer nothing to react to.
 *
 * The prompts are ordered so the *easiest* one comes first. "Hi" is a
 * legitimate opening — the advisor greets back and asks about the
 * skin, which is exactly the conversation the advisor is good at. A
 * customer who types "hi" and gets a routine dumped on them has been
 * sold to; a customer who types "hi" and gets asked about their skin
 * has started a conversation.
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-100 text-brand-600">
        <SparkleIcon width={26} height={26} />
      </span>

      <h2 className="mt-4 text-base font-semibold text-foreground">
        Hi — what can we help with?
      </h2>

      <p className="mt-2 max-w-sm text-sm leading-relaxed text-foreground-muted">
        Tell us about your skin, or attach a photo. We will suggest products
        that suit your routine and flag anything that should not be used
        together.
      </p>

      <ul className="mt-5 flex flex-wrap justify-center gap-2">
        {["Hi", "My skin is oily", "I have dark spots", "What pairs with my serum?"].map(
          (prompt) => (
            <li
              key={prompt}
              className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-foreground-muted"
            >
              {prompt}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/**
 * The "thinking" bubble.
 *
 * A pulsing dot rather than a spinner — three dots that pulse in sequence
 * read as "thinking" in a way a rotating arc does not, and they do not
 * animate indefinitely without settling.
 */
function ThinkingBubble() {
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700"
      >
        <SparkleIcon width={16} height={16} />
      </span>

      <div className="rounded-2xl rounded-bl-sm bg-surface-muted px-4 py-3">
        <span className="sr-only">The advisor is thinking</span>

        <span aria-hidden="true" className="flex items-center gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
