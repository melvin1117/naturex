"use client";

import { BellRing, ExternalLink, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { LoadError } from "@/components/proto/load-error";
import { Button } from "@/components/ui/button";
import type { AlertOut } from "@/lib/api/types";
import { useAlerts, useMarkAlertRead, useMarkAllAlertsRead } from "@/lib/hooks";
import { date } from "@/lib/prototype/format";
import { assetHref } from "@/lib/trade";

/** Severity 4–5 (a downgrade, a big drop, serious news) reads as a warning. */
const URGENT = 4;

/**
 * The signed-in account's alerts (T75), newest first, a page at a time, with read/unread
 * state. Fed by the real `alert` events: a new one refetches the list. `communityId` (the
 * Steward home) asks the API for that community's sites only, so the unread count and "Mark
 * all read" cover exactly what is listed.
 */
export function AlertsList({
  communityId,
  empty,
}: {
  communityId?: string;
  empty: string;
}) {
  const first = useAlerts({ communityId });
  const markAll = useMarkAllAlertsRead();
  const [older, setOlder] = useState<string[]>([]);
  const newest = first.data?.alerts[0]?.id;
  // A new alert shifts every page: start again from the newest page rather than leave a gap.
  useEffect(() => setOlder([]), [newest]);

  if (first.error && !first.data) {
    return (
      <LoadError
        title="We couldn't load your alerts"
        error={first.error}
        retry={first.refetch}
      />
    );
  }
  if (!first.data) {
    return (
      <div
        role="status"
        aria-label="Loading alerts"
        className="h-20 animate-pulse rounded-2xl bg-muted"
      />
    );
  }
  const { alerts, unread_count: unread, next_before: next } = first.data;
  if (alerts.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  const more = (cursor: string) => setOlder((pages) => [...pages, cursor]);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {unread === 0 ? "All read" : `${unread} unread`}
        </p>
        {unread > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={markAll.isPending}
            onClick={() => void markAll.mutate({ communityId })}
          >
            Mark all read
          </Button>
        )}
      </div>
      {markAll.error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {markAll.error.message}
        </p>
      )}
      <ul className="divide-y divide-border" aria-label="Alerts">
        {alerts.map((alert) => (
          <AlertItem key={alert.id} alert={alert} />
        ))}
      </ul>
      {older.map((cursor, i) => (
        <OlderAlerts
          key={cursor}
          communityId={communityId}
          before={cursor}
          onMore={i === older.length - 1 ? more : undefined}
        />
      ))}
      {older.length === 0 && next && <LoadMore onClick={() => more(next)} />}
    </div>
  );
}

function OlderAlerts({
  communityId,
  before,
  onMore,
}: {
  communityId?: string;
  before: string;
  onMore?: (cursor: string) => void;
}) {
  const page = useAlerts({ communityId, before });
  if (page.error && !page.data) {
    return (
      <div className="mt-3">
        <LoadError
          title="We couldn't load older alerts"
          error={page.error}
          retry={page.refetch}
        />
      </div>
    );
  }
  if (!page.data) {
    return (
      <div
        role="status"
        aria-label="Loading older alerts"
        className="mt-3 h-12 animate-pulse rounded-2xl bg-muted"
      />
    );
  }
  const next = page.data.next_before;
  return (
    <>
      <ul
        className="mt-3 divide-y divide-border border-t border-border pt-3"
        aria-label="Older alerts"
      >
        {page.data.alerts.map((alert) => (
          <AlertItem key={alert.id} alert={alert} />
        ))}
      </ul>
      {onMore && next && <LoadMore onClick={() => onMore(next)} />}
    </>
  );
}

function LoadMore({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="mt-3 w-full" onClick={onClick}>
      Show older alerts
    </Button>
  );
}

function AlertItem({ alert }: { alert: AlertOut }) {
  const markRead = useMarkAlertRead();
  const unread = alert.read_at == null;
  const urgent = alert.severity >= URGENT;
  const Icon = urgent ? TriangleAlert : BellRing;
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-xl text-white",
          urgent ? "bg-clay" : "bg-grade-aa",
        )}
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p
          className={cn(
            "text-pretty",
            unread ? "font-semibold" : "font-medium text-muted-foreground",
          )}
        >
          {unread && (
            <span
              className="mr-1.5 mb-0.5 inline-block size-2 rounded-full bg-primary align-middle"
              aria-hidden="true"
            />
          )}
          {alert.title}
          {unread && <span className="sr-only"> (unread)</span>}
        </p>
        {alert.message && (
          <p className="mt-0.5 text-pretty text-muted-foreground">
            {alert.message}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Link
            href={assetHref(alert.asset_id)}
            className="font-medium text-foreground hover:underline"
          >
            {alert.asset_name}
          </Link>
          <span aria-hidden="true">·</span>
          <time dateTime={alert.created_at}>{date(alert.created_at)}</time>
          {alert.url && (
            <>
              <span aria-hidden="true">·</span>
              <a
                href={alert.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 hover:underline"
              >
                Source
                <ExternalLink className="size-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </>
          )}
          {unread && (
            <>
              <span aria-hidden="true">·</span>
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0 text-xs font-medium has-[>svg]:px-0"
                disabled={markRead.isPending}
                onClick={() => void markRead.mutate(alert.id)}
              >
                Mark read
                <span className="sr-only">: {alert.title}</span>
              </Button>
            </>
          )}
        </p>
        {markRead.error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {markRead.error.message}
          </p>
        )}
      </div>
    </li>
  );
}
