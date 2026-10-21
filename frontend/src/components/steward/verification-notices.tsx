"use client";

import { ArrowRight, ShieldCheck, ShieldX, X } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import type { DecisionNotice } from "@/lib/community";
import { focusIfLost } from "@/lib/focus";

/** Where a browser remembers the notices this account dismissed: listing → notice key. */
export function noticesStorageKey(userId: string): string {
  return `naturex:verification-notices:${userId}`;
}

function readSeen(userId: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(noticesStorageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The notices this account dismissed, from this browser. Null until read after mount, so the
 * server render and the first client render agree (and nothing flashes in, then out).
 */
export function useSeenNotices(userId: string | undefined) {
  const [seen, setSeen] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    setSeen(userId ? readSeen(userId) : {});
  }, [userId]);
  const dismiss = useCallback(
    (notice: DecisionNotice) => {
      if (!userId) return;
      const next = { ...readSeen(userId), [notice.assetId]: notice.key };
      try {
        window.localStorage.setItem(
          noticesStorageKey(userId),
          JSON.stringify(next),
        );
      } catch {
        // Storage full or blocked: the notice still goes away for this visit.
      }
      setSeen(next);
    },
    [userId],
  );
  return { seen, dismiss };
}

const ICON = {
  verified: ShieldCheck,
  rejected: ShieldX,
  revoked: ShieldX,
} as const;

/**
 * What a reviewer decided since the steward last looked (#216): approved, not approved or
 * revoked, with the reviewer's reason and the next step. Each stays until dismissed; the next
 * decision brings it back.
 */
export function VerificationNotices({
  notices,
  onDismiss,
  focusWhenEmpty,
  className,
}: {
  notices: DecisionNotice[];
  onDismiss: (notice: DecisionNotice) => void;
  /** Where focus goes once the last notice is dismissed (its button is gone). */
  focusWhenEmpty?: RefObject<HTMLElement | null>;
  className?: string;
}) {
  // A dismissed notice takes its focused button with it: focus the next one's instead.
  const list = useRef<HTMLUListElement>(null);
  const refocus = useRef<number | null>(null);
  useEffect(() => {
    const index = refocus.current;
    if (index === null) return;
    refocus.current = null;
    const buttons =
      list.current?.querySelectorAll<HTMLElement>("[data-dismiss]");
    const next = buttons?.[Math.min(index, buttons.length - 1)];
    focusIfLost(next ?? focusWhenEmpty?.current ?? null);
  }, [notices, focusWhenEmpty]);

  if (notices.length === 0) return null;
  return (
    <section aria-labelledby="notices-title" className={className}>
      <h2 id="notices-title" className="sr-only">
        Verification updates
      </h2>
      <ul ref={list} className="space-y-3">
        {notices.map((notice, index) => {
          const Icon = ICON[notice.level];
          const good = notice.level === "verified";
          return (
            <li
              key={notice.key}
              aria-labelledby={`notice-${notice.assetId}`}
              data-level={notice.level}
              className="nx-rise flex items-start gap-3 rounded-3xl bg-card p-5 shadow-soft sm:gap-4 sm:p-6"
            >
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full sm:size-10",
                  good
                    ? "bg-lime/40 text-lime-ink"
                    : "bg-clay/15 text-clay-ink",
                )}
              >
                <Icon className="size-4 sm:size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h3
                  id={`notice-${notice.assetId}`}
                  className="font-medium text-balance break-words sm:pt-2"
                >
                  {notice.title}
                </h3>
                <p className="mt-1 text-sm text-pretty text-muted-foreground">
                  {notice.body}
                </p>
                {notice.reason && (
                  <blockquote className="mt-3 border-l-2 border-border pl-3 text-sm break-words">
                    <span className="text-muted-foreground">
                      {good ? "Reviewer's note: " : "Reviewer's reason: "}
                    </span>
                    “{notice.reason}”
                  </blockquote>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {notice.action && (
                    <Button asChild size="sm">
                      <Link href={notice.action.href}>
                        {notice.action.label}
                        <ArrowRight aria-hidden="true" />
                      </Link>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-dismiss=""
                    aria-label={`Dismiss: ${notice.title}`}
                    onClick={() => {
                      refocus.current = index;
                      onDismiss(notice);
                    }}
                  >
                    <X aria-hidden="true" />
                    Dismiss
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
