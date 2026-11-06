"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { BellIcon, CheckIcon, ClockIcon, CloseIcon } from "@/components/ui/icons";

import { formatPaisa } from "@/lib/format/money";
import { paymentMethodLabel } from "@/lib/format/payment";
import type {
  AdminNotification,
  AdminNotificationInbox,
  AdminNotificationKind,
} from "@/lib/format/types";
import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The admin notification bell.
 *
 * ── What it is ────────────────────────────────────────────────────────────
 *
 * The admin's inbox. A customer places an order, the checkout writes a
 * notification row in the **same transaction as the order**, and this
 * bell polls for it. The badge shows how many are unread; the dropdown
 * shows the recent ones.
 *
 * ── Why polling, and not a WebSocket ──────────────────────────────────────
 *
 * Polling is the right tool here, for three reasons that all point the
 * same way:
 *
 *   1. **The shop is small.** A handful of admin desks and a handful of
 *      orders an hour. A socket per admin would be more machinery than
 *      the traffic justifies.
 *
 *   2. **It survives a reload.** The bell's state lives in the
 *      database, not in a connection. An admin who refreshes the page
 *      — or opens it in a second tab — sees the same unread count. A
 *      socket-only design would show an empty inbox until the next
 *      order arrived.
 *
 *   3. **It cannot leak.** A long-lived socket holds a database
 *      connection open behind it. A poll takes the connection, uses it
 *      and gives it back.
 *
 * The poll interval is **20 seconds**. Long enough not to hammer the
 * database, short enough that an order placed at the desk is on the
 * desk's screen before the admin has finished reading the page.
 *
 * ── The rules that shape it ───────────────────────────────────────────────
 *
 * **1. The server is the authority for "unread".**
 *
 * The badge is not computed from the notifications the browser happens
 * to be holding. It is the server's `countUnreadNotifications()`, which
 * counts every unread row — including ones older than the twenty the
 * dropdown shows. An admin with thirty unread orders sees "30", not "12".
 *
 * **2. A toast appears only for something the admin has not seen.**
 *
 * The toast fires when the poll finds a notification whose id is not in
 * the set the browser already knew about. It is the *difference* between
 * two polls that matters — not "the poll returned something".
 *
 * **3. The toast does not mark anything read.**
 *
 * Reading is an explicit act. A toast that dismissed itself and cleared
 * the badge would mean the admin never actually looked at the order —
 * and the badge would lie about what has been seen.
 */

/**
 * How often the bell polls, in milliseconds.
 */
const POLL_INTERVAL_MS = 20_000;

/**
 * How long a toast stays on screen.
 */
const TOAST_DURATION_MS = 8_000;

/**
 * The kind of a notification, and how it reads.
 */
const KIND_COPY: Record<
  AdminNotificationKind,
  { readonly title: string; readonly tone: string }
> = {
  ORDER_PLACED: {
    title: "New order placed",
    tone: "bg-brand-50 text-brand-700 ring-brand-200",
  },
  PAYMENT_SETTLED: {
    title: "Payment received",
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  PAYMENT_FAILED: {
    title: "Payment failed",
    tone: "bg-red-50 text-red-700 ring-red-200",
  },
};

/**
 * The bell.
 */
export function AdminNotificationBell() {
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<AdminNotification | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * The ids the browser has already seen.
   *
   * The set is what makes the toast fire **once** per notification. A
   * notification already in the set is one the admin has been told about,
   * so a poll that returns it again must not raise a second toast.
   */
  const seenIdsRef = useRef<Set<string>>(new Set());

  /**
   * Whether the first poll has landed.
   *
   * The very first poll must **not** raise a toast. An admin who opens
   * the dashboard should not be shown thirty toasts for the orders that
   * arrived while they were away — that is what the badge is for. The
   * toast is for the *new* thing, not the backlog.
   */
  const hasLoadedRef = useRef(false);

  const fetchInbox = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/admin/notifications?limit=20", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });

      const payload = (await response.json()) as ApiEnvelope<AdminNotificationInbox>;

      if (!payload.ok) return;

      const incoming = payload.data.notifications;

      // The first poll seeds the "already seen" set without a toast.
      if (!hasLoadedRef.current) {
        hasLoadedRef.current = true;

        for (const notification of incoming) {
          seenIdsRef.current.add(notification.id);
        }
      } else {
        // Anything the browser has never seen is genuinely new.
        const fresh = incoming.find(
          (notification) => !seenIdsRef.current.has(notification.id),
        );

        if (fresh) {
          seenIdsRef.current.add(fresh.id);
          setToast(fresh);
        }
      }

      setNotifications(incoming);
      setUnreadCount(payload.data.unreadCount);
    } catch {
      // A failed poll is not an error the admin needs to see. The bell
      // simply keeps its last known state and tries again on the next
      // tick — showing a red error for a transient network blip would
      // be noise, and the next poll fixes it.
    }
  }, []);

  // The poll.
  useEffect(() => {
    void fetchInbox();

    const timer = setInterval(() => {
      void fetchInbox();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [fetchInbox]);

  // The toast dismisses itself after a while.
  useEffect(() => {
    if (!toast) return;

    const timer = setTimeout(() => {
      setToast(null);
    }, TOAST_DURATION_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  // Escape closes the dropdown.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      setIsOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  // An outside click closes the dropdown.
  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target;

      if (!(target instanceof Node)) return;

      if (containerRef.current?.contains(target)) return;

      setIsOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [isOpen]);

  /**
   * Marks one notification as read.
   *
   * The badge is decremented **optimistically** and then reconciled with
   * the server's count. A bell that waited for a round trip before
   * clearing its badge feels broken, even when it is only 80ms.
   */
  async function markRead(notificationId: string): Promise<void> {
    const target = notifications.find(
      (notification) => notification.id === notificationId,
    );

    if (!target || target.read) return;

    setNotifications((current) =>
      current.map((notification) =>
        notification.id === notificationId
          ? { ...notification, read: true }
          : notification,
      ),
    );

    setUnreadCount((count) => Math.max(0, count - 1));

    try {
      await fetch(`/api/admin/notifications/${notificationId}/read`, {
        method: "PATCH",
        headers: { accept: "application/json" },
      });

      await fetchInbox();
    } catch {
      // The optimistic update is reconciled by the next poll.
      await fetchInbox();
    }
  }

  /**
   * Marks everything as read.
   *
   * The badge goes to zero immediately, because "mark all read" means
   * exactly that — and the server's count comes back on the next poll
   * to correct it if the request failed.
   */
  async function markAllRead(): Promise<void> {
    setNotifications((current) =>
      current.map((notification) => ({ ...notification, read: true })),
    );

    setUnreadCount(0);

    try {
      await fetch("/api/admin/notifications/read-all", {
        method: "PATCH",
        headers: { accept: "application/json" },
      });

      await fetchInbox();
    } catch {
      await fetchInbox();
    }
  }

  return (
    <>
      <div ref={containerRef} className="relative">
        {/*
          The trigger.

          `aria-expanded` and `aria-controls` describe the dropdown to
          assistive technology, and the accessible name says what the
          control is — the icon is decorative, so the badge count alone
          would not be an adequate name.
        */}
        <button
          ref={triggerRef}
          type="button"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : "Notifications, none unread"
          }
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls="admin-notification-panel"
          onClick={() => {
            setIsOpen((open) => !open);
          }}
          className={[
            "relative inline-flex h-10 w-10 items-center justify-center rounded-full",
            "text-foreground-muted transition-colors duration-200",
            "hover:bg-surface-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
            "focus-visible:ring-offset-surface",
          ].join(" ")}
        >
          <BellIcon className="h-5 w-5" />

          {unreadCount > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-[18px] text-white ring-2 ring-surface"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </button>

        {isOpen ? (
          <div
            id="admin-notification-panel"
            role="dialog"
            aria-label="Notifications"
            className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">
                Notifications
              </h2>

              {unreadCount > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    void markAllRead();
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                >
                  <CheckIcon width={13} height={13} />
                  Mark all read
                </button>
              ) : null}
            </div>

            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-foreground">No notifications yet</p>
                <p className="mt-1 text-xs text-foreground-muted">
                  New orders will appear here the moment they are placed.
                </p>
              </div>
            ) : (
              <ul className="max-h-96 divide-y divide-border overflow-y-auto">
                {notifications.map((notification) => (
                  <li key={notification.id}>
                    <NotificationRow
                      notification={notification}
                      onRead={() => {
                        void markRead(notification.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {toast ? (
        <NotificationToast
          notification={toast}
          onDismiss={() => {
            setToast(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One notification in the dropdown.
 */
function NotificationRow({
  notification,
  onRead,
}: {
  readonly notification: AdminNotification;
  readonly onRead: () => void;
}) {
  const copy = KIND_COPY[notification.kind];

  return (
    <div
      className={[
        "flex items-start gap-3 px-4 py-3 transition-colors",
        notification.read ? "opacity-60" : "bg-brand-50/40",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1",
          copy.tone,
        ].join(" ")}
      >
        <BellIcon width={14} height={14} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-foreground">
          {copy.title}
        </p>

        <p className="mt-0.5 truncate text-xs text-foreground-muted">
          {notification.orderNumber} · {notification.customerName} ·{" "}
          {formatPaisa(notification.totalAmountPaisa)}
        </p>

        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-foreground-muted">
          <ClockIcon width={11} height={11} />
          {paymentMethodLabel(notification.paymentMethod)} ·{" "}
          {formatRelativeTime(notification.createdAt)}
        </p>

        <div className="mt-2 flex items-center gap-3">
          <Link
            href={`/admin/orders?search=${encodeURIComponent(notification.orderNumber)}`}
            className="text-[11px] font-medium text-brand-700 underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            View order
          </Link>

          {notification.read ? null : (
            <button
              type="button"
              onClick={onRead}
              className="text-[11px] font-medium text-foreground-muted underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              Mark read
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The toast.
 *
 * It appears in the **bottom-right** corner — away from the bell, so it
 * does not obscure the badge it is reporting — and it is announced
 * politely, because a toast that interrupts whatever the admin was
 * typing would be worse than no toast at all.
 */
function NotificationToast({
  notification,
  onDismiss,
}: {
  readonly notification: AdminNotification;
  readonly onDismiss: () => void;
}) {
  const copy = KIND_COPY[notification.kind];

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[60] w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-4 shadow-lg motion-safe:animate-[notification-toast-in_200ms_cubic-bezier(0.16,1,0.3,1)]"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={[
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1",
            copy.tone,
          ].join(" ")}
        >
          <BellIcon width={15} height={15} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{copy.title}</p>

          <p className="mt-0.5 truncate text-xs text-foreground-muted">
            {notification.orderNumber} · {notification.customerName}
          </p>

          <p className="mt-0.5 text-xs text-foreground-muted">
            {formatPaisa(notification.totalAmountPaisa)} ·{" "}
            {paymentMethodLabel(notification.paymentMethod)}
          </p>

          <Link
            href={`/admin/orders?search=${encodeURIComponent(notification.orderNumber)}`}
            className="mt-2 inline-block text-xs font-medium text-brand-700 underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            View order
          </Link>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss the notification"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * Formats a timestamp as "how long ago".
 *
 * Deliberately coarse — "just now", "5m ago", "3h ago", "2d ago" —
 * because the bell is about *recency*, not about a timestamp. The exact
 * time is on the order page.
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();

  if (Number.isNaN(then)) return "";

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));

  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);

  if (days < 30) return `${days}d ago`;

  const months = Math.round(days / 30);

  return `${months}mo ago`;
}
