"use client";

import { Bell, Bot, MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { AlertsList } from "@/components/alerts-list";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAlerts, useWorld } from "@/lib/hooks";
import type { AppKey } from "@/lib/navigation";
import { date } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import {
  actingTrader,
  markAlertsRead,
  type TraderKey,
} from "@/lib/prototype/world";

/**
 * The header tools (Copilot, Agent Trace, alerts). The shell header
 * (`components/shell/app-header.tsx`) shows them in its `tools` slot. Signed-in accounts get
 * their real alerts (T75, #199) and the real Agent Trace (T34); anonymous visitors keep the
 * prototype's scripted alerts.
 */
export function PrototypeHeaderTools({ app }: { app: AppKey }) {
  const pathname = usePathname();
  const { world, openCopilot, openTrace } = usePrototype();
  const signedIn = Boolean(useWorld().world?.me);
  // Alerts follow the persona you're viewing as, the same account that trades.
  const trader: TraderKey | null =
    app === "admin" ? null : actingTrader(world.persona);
  return (
    <>
      {app === "exchange" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            openCopilot(
              pathname.startsWith("/asset/") ? pathname.split("/")[2] : null,
            )
          }
          data-tour="copilot-button"
        >
          <MessageCircle aria-hidden="true" />
          <span className="sr-only xl:not-sr-only">Copilot</span>
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => openTrace()}
        data-tour="trace-button"
      >
        <Bot aria-hidden="true" />
        <span className="sr-only xl:not-sr-only">Agent Trace</span>
      </Button>
      {signedIn ? (
        <AccountAlertsBell />
      ) : (
        trader && <AlertsBell trader={trader} />
      )}
    </>
  );
}

/**
 * The signed-in account's alerts (`GET /alerts`): the unread count on the bell, announced
 * when it changes, and the list with mark read, mark all read and links to each site. Live
 * `alert` events refetch it (`wireLiveUpdates`).
 */
function AccountAlertsBell() {
  const [open, setOpen] = useState(false);
  const alerts = useAlerts();
  const loaded = alerts.data !== undefined;
  const unread = alerts.data?.unread_count ?? 0;
  const announcement = useCountAnnouncement(loaded ? unread : null);
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
            <Bell aria-hidden="true" />
            {unread > 0 && (
              <span
                className="tabular absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-clay px-1 text-[10px] font-semibold text-white"
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
          <div className="border-b px-4 py-3 text-sm font-semibold">Alerts</div>
          <div className="max-h-[min(28rem,70vh)] overflow-y-auto px-4 py-3">
            <AlertsList empty="No alerts yet. You'll hear here when a site you back is re-rated or in the news." />
          </div>
        </PopoverContent>
      </Popover>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

function AlertsBell({ trader }: { trader: TraderKey }) {
  const { world, act } = usePrototype();
  const alerts = world.alerts.filter((a) => a.persona === trader);
  const unread = alerts.filter((a) => !a.read).length;
  return (
    <Popover
      onOpenChange={(open) =>
        !open && unread && act((w) => markAlertsRead(w, trader))
      }
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          data-tour="alerts-bell"
        >
          <Bell aria-hidden="true" />
          <span className="sr-only">
            Alerts{unread ? `, ${unread} unread` : ""}
          </span>
          {unread > 0 && (
            <span className="tabular absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-clay px-1 text-[10px] font-semibold text-white">
              {unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-2xl p-0">
        <div className="border-b px-4 py-3 text-sm font-semibold">Alerts</div>
        {alerts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No alerts yet. You&apos;ll hear here when a site you back is
            re-rated.
          </p>
        ) : (
          <ul className="max-h-80 divide-y overflow-auto">
            {alerts.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/asset/${a.siteId}`}
                  className="block px-4 py-3 hover:bg-accent"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        a.severity === "critical" ? "bg-clay" : "bg-lime-ink",
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{a.title}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {a.message}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {date(a.date)}
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * What a polite live region says about the unread count: nothing on the first load (the
 * bell's label has it), then the new count whenever more alerts arrive.
 */
function useCountAnnouncement(count: number | null): string {
  const previous = useRef<number | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (count === null) return;
    if (previous.current !== null && count > previous.current)
      setText(`${count} unread ${count === 1 ? "alert" : "alerts"}`);
    previous.current = count;
  }, [count]);
  return text;
}
