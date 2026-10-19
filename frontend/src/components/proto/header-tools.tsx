"use client";

import { Bell, Bot, MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AppKey } from "@/lib/navigation";
import { date } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import {
  actingTrader,
  markAlertsRead,
  type TraderKey,
} from "@/lib/prototype/world";

/**
 * The prototype's header tools (Copilot, Agent Trace, alerts), on scripted data until their
 * tasks wire them. The shell header (`components/shell/app-header.tsx`) shows them in its
 * `tools` slot.
 */
export function PrototypeHeaderTools({ app }: { app: AppKey }) {
  const pathname = usePathname();
  const { world, openCopilot, openTrace } = usePrototype();
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
      {trader && <AlertsBell trader={trader} />}
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
