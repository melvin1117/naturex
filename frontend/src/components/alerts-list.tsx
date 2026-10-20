"use client";

import { BellRing, ExternalLink, TriangleAlert } from "lucide-react";
import Link from "next/link";
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
 * The signed-in account's alerts (T75), newest first, with read/unread state. Fed by the real
 * `alert` events: a new one refetches the list. `assetIds` narrows it to some sites (the
 * Steward home shows only its community's); then "Mark all read" is hidden, because it would
 * also read alerts that aren't shown.
 */
export function AlertsList({
  assetIds,
  empty,
}: {
  assetIds?: ReadonlySet<string>;
  empty: string;
}) {
  const alerts = useAlerts();
  const markAll = useMarkAllAlertsRead();

  if (alerts.error && !alerts.data) {
    return (
      <LoadError
        title="We couldn't load your alerts"
        error={alerts.error}
        retry={alerts.refetch}
      />
    );
  }
  if (!alerts.data) {
    return (
      <div
        role="status"
        aria-label="Loading alerts"
        className="h-20 animate-pulse rounded-2xl bg-muted"
      />
    );
  }
  const shown = assetIds
    ? alerts.data.alerts.filter((a) => assetIds.has(a.asset_id))
    : alerts.data.alerts;
  const unread = shown.filter((a) => a.read_at == null).length;

  if (shown.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {unread === 0 ? "All read" : `${unread} unread`}
        </p>
        {!assetIds && alerts.data.unread_count > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={markAll.isPending}
            onClick={() => void markAll.mutate()}
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
        {shown.map((alert) => (
          <AlertItem key={alert.id} alert={alert} />
        ))}
      </ul>
    </div>
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
            "flex items-center gap-2",
            unread ? "font-semibold" : "font-medium text-muted-foreground",
          )}
        >
          {unread && (
            <span
              className="size-2 shrink-0 rounded-full bg-primary"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 text-pretty">{alert.title}</span>
          {unread && <span className="sr-only">(unread)</span>}
        </p>
        {alert.message && (
          <p className="mt-0.5 text-pretty text-muted-foreground">
            {alert.message}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
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
        </p>
        {markRead.error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {markRead.error.message}
          </p>
        )}
      </div>
      {unread && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          disabled={markRead.isPending}
          onClick={() => void markRead.mutate(alert.id)}
        >
          Mark read
          <span className="sr-only">: {alert.title}</span>
        </Button>
      )}
    </li>
  );
}
