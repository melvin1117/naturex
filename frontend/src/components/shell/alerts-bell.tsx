"use client";

import { useEffect, useRef, useState } from "react";

import { AlertsList } from "@/components/alerts-list";
import { AlertsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAlerts, useWorld } from "@/lib/hooks";

/**
 * The header's alerts bell (WildWatch): a plain bell while the world loads, then the account's
 * real alerts (T75, #199). Everyone in a sandbox is someone, so there's always an account.
 */
export function AlertsBell() {
  const { world, status } = useWorld();
  if (!world && (status === "idle" || status === "loading"))
    return <PendingAlertsBell />;
  return world?.me ? <AccountAlertsBell accountId={world.me.id} /> : null;
}

/**
 * The signed-in account's alerts (`GET /alerts`): the unread count on the bell, announced
 * when it changes, and the list with mark read, mark all read and links to each site. Live
 * `alert` events refetch it (`wireLiveUpdates`).
 */
function AccountAlertsBell({ accountId }: { accountId: string | null }) {
  const [open, setOpen] = useState(false);
  const alerts = useAlerts();
  const loaded = alerts.data !== undefined;
  const unread = alerts.data?.unread_count ?? 0;
  const announcement = useCountAnnouncement(loaded ? unread : null, accountId);
  const label = unread
    ? `Alerts, ${unread} unread`
    : loaded
      ? "Alerts, all read"
      : "Alerts";
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative"
            aria-label={label}
            data-tour="alerts-bell"
          >
            <AlertsIcon aria-hidden="true" />
            {unread > 0 && (
              <span
                className="tabular absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-clay-ink px-1 text-[10px] font-semibold text-white"
                aria-hidden="true"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(24rem,calc(100vw-2rem))] rounded-2xl p-0"
          aria-label="Your alerts"
          // Following a link to a site closes the list.
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a[href^='/']"))
              setOpen(false);
          }}
        >
          <div className="border-b px-4 py-3 text-sm font-semibold">
            WildWatch alerts
          </div>
          <div className="max-h-[min(28rem,70vh)] overflow-y-auto px-4 py-3">
            <AlertsList empty="No alerts yet. WildWatch tells you here when a site you back is re-rated or in the news." />
          </div>
        </PopoverContent>
      </Popover>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

/** The bell while the world loads: no count and nothing to open yet. */
function PendingAlertsBell() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Alerts"
      disabled
      data-tour="alerts-bell"
    >
      <AlertsIcon aria-hidden="true" />
    </Button>
  );
}

/**
 * What a polite live region says about the unread count: nothing on the first load (the
 * bell's label has it) or for another account's first load, then the new count whenever more
 * alerts arrive. The text is cleared first, so a count heard before is announced again.
 */
function useCountAnnouncement(
  count: number | null,
  accountId: string | null,
): string {
  const previous = useRef<{ accountId: string | null; count: number } | null>(
    null,
  );
  const [text, setText] = useState("");
  useEffect(() => {
    const before = previous.current;
    if (count === null || (before && before.accountId !== accountId)) {
      previous.current = null;
      setText("");
      if (count === null) return;
    }
    const last = previous.current?.count ?? null;
    previous.current = { accountId, count };
    if (last === null || count <= last) return;
    setText("");
    const timer = setTimeout(
      () => setText(`${count} unread ${count === 1 ? "alert" : "alerts"}`),
      ANNOUNCE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [count, accountId]);
  return text;
}

/** Long enough for screen readers to notice the live region was emptied. */
const ANNOUNCE_DELAY_MS = 100;
