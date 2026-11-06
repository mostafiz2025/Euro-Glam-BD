import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { AdvisorChat } from "@/app/(storefront)/advisor/components/AdvisorChat";
import { SkinProfileForm } from "@/app/(storefront)/advisor/components/SkinProfileForm";
import { ButtonLink } from "@/components/ui/button";
import { ChevronRightIcon, SparkleIcon } from "@/components/ui/icons";
import { getOptionalUser, type SessionUser } from "@/lib/auth/guards";
import { getConversation, listConversations } from "@/lib/ai/conversations";
import { loadDisclaimer } from "@/lib/ai/disclaimer";
import { loadSkinContext } from "@/lib/ai/service";
import { db } from "@/lib/db";
import { SKIN_CONCERNS } from "@/lib/validation/advisor";

/**
 * The AI Advisor page.
 *
 * ── The rules that govern this page ──────────────────────────────────────
 *
 * **1. A signed-out visitor is offered a sign-in, not an error.**
 *
 * The advisor's conversations and skin profile belong to a user, so a
 * visitor without a session cannot have them. A 401 here would be
 * technically true and useless — the customer clicked "Ask the advisor"
 * and got told they were wrong. The page explains what the advisor is
 * for and points them at the sign-in.
 *
 * **2. The session is read at the top of the page.**
 *
 * This page is **request-time**, and it says so with `await
 * connection()`. A session read goes through `cookies()`, which is a
 * *dynamic* API. Under Cache Components, a dynamic read inside a
 * `<Suspense>` boundary defers that boundary indefinitely — the
 * fallback is sent and the real content never arrives. The customer
 * would be left staring at a skeleton that never resolves.
 *
 * So the session is read **outside** the boundary, where the framework
 * can see that the page is dynamic. The database reads still stream
 * behind the boundary, because a database read defers cleanly.
 *
 * **3. The disclaimer is loaded server-side and passed down.**
 *
 * The banner must be visible before the first message, and it must not
 * be dismissible. Fetching it from the client would leave a window
 * where the page renders without it. Loading it here means the banner
 * is in the first paint.
 */

export const metadata: Metadata = {
  title: "AI Skincare Advisor",
  description:
    "Tell us about your skin and get product suggestions that suit your routine, with ingredient conflicts flagged.",
};

/**
 * This route is allowed to block.
 *
 * The advisor belongs to a user, so the page cannot be prerendered: it
 * depends on who is asking. Under Cache Components a route that reads
 * the session has to declare that it may block, with
 * `export const instant = false`.
 */
export const instant = false;

/**
 * The advisor page.
 */
export default async function AdvisorPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ conversationId?: string }>;
}) {
  await connection();

  const user = await getOptionalUser();
  const params = await searchParams;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      {/* ── The breadcrumb ───────────────────────────────────────────── */}
      <nav aria-label="Breadcrumb" className="mb-4">
        <ol className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <li>
            <Link
              href="/"
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Home
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>
          <li>
            <span aria-current="page" className="font-medium text-foreground">
              AI Advisor
            </span>
          </li>
        </ol>
      </nav>

      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <SparkleIcon width={18} height={18} />
        </span>

        <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          AI Skincare Advisor
        </h1>
      </div>

      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground-muted">
        Tell us about your skin, or attach a photo. We will suggest products
        that suit your routine — and tell you plainly when two things should
        not be used together.
      </p>

      <div className="mt-6">
        <Suspense fallback={<AdvisorSkeleton />}>
          <AdvisorBody user={user} conversationId={params.conversationId} />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * The advisor body.
 */
async function AdvisorBody({
  user,
  conversationId,
}: {
  readonly user: SessionUser | null;
  readonly conversationId: string | undefined;
}) {
  if (!user) {
    return <SignedOut />;
  }

  // The disclaimer and the conversation list are independent reads, so
  // they run together. A failure in either is caught below — a page
  // that says "we could not load this" is better than a page that
  // crashes.
  const [disclaimer, conversations, profile] = await Promise.all([
    loadDisclaimer(),
    listConversations(user.id, 20).catch((error: unknown) => {
      console.error("[advisor] Conversation list failed:", error);
      return { conversations: [], nextCursor: null };
    }),
    loadSkinContext(user.id).catch((error: unknown) => {
      console.error("[advisor] Skin profile load failed:", error);
      return { skinType: null, concerns: [], notes: null };
    }),
  ]);

  // The opened conversation, if the customer followed a history link.
  //
  // `getConversation` returns `null` for a conversation that does not
  // exist *or* belongs to somebody else, so a hand-edited id shows an
  // empty transcript rather than somebody else's messages.
  const opened = conversationId
    ? await getConversation(user.id, conversationId).catch((error: unknown) => {
        console.error("[advisor] Conversation load failed:", error);
        return null;
      })
    : null;

  const profileRows = await db.userSkinProfile
    .findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        skinType: true,
        concerns: true,
        notes: true,
        estimatedEmptyAt: true,
        smsOptIn: true,
        profileImageId: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    .catch((error: unknown) => {
      console.error("[advisor] Profile load failed:", error);
      return null;
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* ── The chat ──────────────────────────────────────────────────── */}
      <div className="flex min-h-[32rem] flex-col rounded-[var(--radius-card)] border border-border bg-surface">
        {/*
          The `key` is the conversation id.

          Opening a different conversation must **mount** a different
          component, not reconcile the old one against the new props.
          Without it, `useState(initialMessages)` keeps the first
          conversation's transcript on screen under the new one's
          title — the customer reads one conversation while the page
          claims to show another.
        */}
        <AdvisorChat
          key={opened?.id ?? "new"}
          conversationId={opened?.id ?? null}
          initialMessages={opened?.messages ?? []}
          conversations={conversations.conversations}
          disclaimer={disclaimer}
        />
      </div>

      {/* ── The profile ───────────────────────────────────────────────── */}
      <aside className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
        <SkinProfileForm
          profile={{
            id: profileRows?.id ?? null,
            skinType: profileRows?.skinType ?? profile.skinType ?? null,
            concerns: profileRows?.concerns ?? profile.concerns,
            notes: profileRows?.notes ?? profile.notes ?? null,
            estimatedEmptyAt:
              profileRows?.estimatedEmptyAt?.toISOString() ?? null,
            smsOptIn: profileRows?.smsOptIn ?? false,
            profileImageId: profileRows?.profileImageId ?? null,
            isEmpty: profileRows === null,
            createdAt: profileRows?.createdAt.toISOString() ?? null,
            updatedAt: profileRows?.updatedAt.toISOString() ?? null,
          }}
          concerns={CONCERN_LABELS}
          skinTypes={SKIN_TYPE_LABELS}
        />
      </aside>
    </div>
  );
}

/**
 * The readable text for each concern id.
 *
 * Declared **before** `CONCERN_LABELS`, because a `const` is in the
 * temporal dead zone until its declaration is evaluated. A map that
 * reads the table above it throws at module scope — which, in a Next.js
 * page, is a build-time "failed to collect page data" rather than an
 * error anyone can trace to the line that caused it.
 */
const CONCERN_TEXT: Record<(typeof SKIN_CONCERNS)[number], string> = {
  ACNE: "Acne",
  BLACKHEADS: "Blackheads",
  DULLNESS: "Dullness",
  DRYNESS: "Dryness",
  FINE_LINES: "Fine lines",
  OILINESS: "Oiliness",
  PORE_SIZE: "Large pores",
  REDNESS: "Redness",
  SENSITIVITY: "Sensitivity",
  DARK_SPOTS: "Dark spots",
  UNEVEN_TONE: "Uneven tone",
  DEHYDRATION: "Dehydration",
};

/**
 * The concern catalogue, with human labels.
 *
 * The ids are the wire format — they are what the API stores and what the
 * catalogue's filters match on. The labels are what the customer reads.
 * Keeping them in one table means a new concern cannot be added to the
 * UI without being added to the API's vocabulary, or the other way round.
 */
const CONCERN_LABELS = SKIN_CONCERNS.map((id) => ({
  id,
  label: CONCERN_TEXT[id],
}));

/**
 * The skin types, with human labels.
 */
const SKIN_TYPE_LABELS = [
  { id: "NORMAL", label: "Normal" },
  { id: "DRY", label: "Dry" },
  { id: "OILY", label: "Oily" },
  { id: "COMBINATION", label: "Combination" },
  { id: "SENSITIVE", label: "Sensitive" },
  { id: "ACNE_PRONE", label: "Acne-prone" },
  { id: "UNKNOWN", label: "Not sure yet" },
] as const;

/**
 * The signed-out state.
 */
function SignedOut() {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
      <h2 className="text-base font-semibold text-foreground">
        Sign in to use the advisor
      </h2>

      <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
        Your skin profile and your conversations are saved to your account,
        so the advisor remembers what you told it.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink href="/login" variant="primary" size="sm">
          Sign in
        </ButtonLink>

        <ButtonLink href="/products" variant="outline" size="sm">
          Browse the catalogue
        </ButtonLink>
      </div>
    </div>
  );
}

/**
 * The placeholder shown while the advisor loads.
 */
function AdvisorSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-h-[32rem] rounded-[var(--radius-card)] bg-surface-muted" />
      <div className="h-96 rounded-[var(--radius-card)] bg-surface-muted" />
    </div>
  );
}
