"use client";

import { Bell, Bot, MessageCircle, Repeat2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { AccountMenu } from "@/components/account-menu";
import { Wordmark } from "@/components/proto/bits";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { date } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import {
  actingTrader,
  markAlertsRead,
  type TraderKey,
} from "@/lib/prototype/world";

export type AppKey = "exchange" | "steward" | "admin";

const NAV: Record<AppKey, { href: string; label: string; tour?: string }[]> = {
  exchange: [
    { href: "/", label: "Marketplace", tour: "nav-marketplace" },
    { href: "/portfolio", label: "Your stakes", tour: "nav-portfolio" },
  ],
  steward: [
    { href: "/steward", label: "Community home" },
    { href: "/steward/list", label: "List land", tour: "nav-list" },
  ],
  admin: [{ href: "/admin", label: "Time Machine" }],
};

const APP_NAME: Record<AppKey, string> = {
  exchange: "Exchange",
  steward: "Steward",
  admin: "Control room",
};

function isActive(pathname: string, href: string) {
  if (href === "/" || href === "/steward" || href === "/admin")
    return pathname === href;
  return pathname.startsWith(href);
}

export function AppHeader({ app }: { app: AppKey }) {
  const pathname = usePathname();
  const { world, openCopilot, openTrace } = usePrototype();
  // Alerts follow the persona you're viewing as, the same account that trades.
  const trader: TraderKey | null =
    app === "admin" ? null : actingTrader(world.persona);

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:h-16 sm:flex-nowrap sm:px-6 sm:py-0">
        <Link
          href={
            app === "exchange" ? "/" : app === "steward" ? "/steward" : "/admin"
          }
          className="shrink-0 rounded-md"
        >
          <Wordmark app={APP_NAME[app]} />
        </Link>
        <nav
          aria-label={`${APP_NAME[app]} navigation`}
          className="order-last -mx-1 w-full min-w-0 overflow-x-auto sm:order-none sm:mx-0 sm:w-auto"
        >
          <ul className="flex items-center gap-1">
            {NAV[app].map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  data-tour={item.tour}
                  aria-current={
                    isActive(pathname, item.href) ? "page" : undefined
                  }
                  className={cn(
                    "inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors",
                    isActive(pathname, item.href)
                      ? "bg-card text-foreground shadow-soft"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          {app === "exchange" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                openCopilot(
                  pathname.startsWith("/asset/")
                    ? pathname.split("/")[2]
                    : null,
                )
              }
              data-tour="copilot-button"
            >
              <MessageCircle aria-hidden="true" />
              <span className="hidden sm:inline">Copilot</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openTrace()}
            data-tour="trace-button"
          >
            <Bot aria-hidden="true" />
            <span className="hidden sm:inline">Agent Trace</span>
          </Button>
          {trader && <AlertsBell trader={trader} />}
          {app !== "admin" && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="hidden md:inline-flex"
            >
              <Link href={app === "exchange" ? "/steward" : "/"}>
                <Repeat2 aria-hidden="true" />
                {app === "exchange" ? "Steward app" : "Exchange"}
              </Link>
            </Button>
          )}
          <AccountMenu />
        </div>
      </div>
    </header>
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
