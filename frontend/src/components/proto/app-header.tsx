"use client";

import { Bell, Bot, Menu, MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "cn";

import { AccountMenu } from "@/components/account-menu";
import {
  AppSwitcher,
  CreateCommunityLink,
  useAppAccess,
} from "@/components/app-switcher";
import { Wordmark } from "@/components/proto/bits";
import {
  CommunitySwitcher,
  useOptionalStewardCommunity,
} from "@/components/steward-community";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  APP_NAV,
  APPS,
  isActive,
  type AppAccess,
  type AppKey,
} from "@/lib/navigation";
import { date } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import {
  actingTrader,
  markAlertsRead,
  type TraderKey,
} from "@/lib/prototype/world";

export type { AppKey };

/**
 * The shell header of the Exchange, the Steward app and the control room (T62). Navigation
 * follows the signed-in account's roles (`useAppAccess`); from `lg` down, the pages, the app
 * switcher and the community switcher move into a menu sheet.
 */
export function AppHeader({ app }: { app: AppKey }) {
  const pathname = usePathname();
  const { world, openCopilot, openTrace } = usePrototype();
  const access = useAppAccess();
  const steward = useOptionalStewardCommunity();
  // Alerts follow the persona you're viewing as, the same account that trades.
  const trader: TraderKey | null =
    app === "admin" ? null : actingTrader(world.persona);
  const offerCreate = access.canCreateCommunity && app !== "steward";
  // An account without a community gets the Steward app's empty state on every page there.
  const showPages = !(app === "steward" && access.canCreateCommunity);

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-x-3 px-4 sm:px-6 lg:gap-x-6">
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          <Link href={APPS[app].href} className="shrink-0 rounded-md">
            <Wordmark app={APPS[app].name} />
          </Link>
          {app === "steward" && steward?.active && (
            <div className="hidden min-w-0 items-center gap-3 lg:flex">
              <span aria-hidden="true" className="text-border">
                /
              </span>
              <CommunitySwitcher />
            </div>
          )}
        </div>
        {showPages && (
          <AppNav app={app} pathname={pathname} className="hidden lg:block" />
        )}
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
          <AppSwitcher
            current={app}
            access={access}
            className="ml-1.5 hidden lg:block"
          />
          {offerCreate && (
            <CreateCommunityLink className="ml-1.5 hidden lg:inline-flex" />
          )}
          <AccountMenu />
          <MobileMenu
            app={app}
            access={access}
            pathname={pathname}
            offerCreate={offerCreate}
            showPages={showPages}
          />
        </div>
      </div>
    </header>
  );
}

function AppNav({
  app,
  pathname,
  layout = "row",
  className,
  onNavigate,
}: {
  app: AppKey;
  pathname: string;
  layout?: "row" | "stack";
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={`${APPS[app].name} navigation`} className={className}>
      <ul
        className={cn(
          "flex gap-1",
          layout === "stack" ? "flex-col items-stretch" : "items-center",
        )}
      >
        {APP_NAV[app].map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                data-tour={layout === "row" ? item.tour : undefined}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  "inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors",
                  layout === "stack" && "flex h-11 w-full",
                  active
                    ? "bg-card text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Below `lg`: the app's pages, the community and app switchers in a sheet. */
function MobileMenu({
  app,
  access,
  pathname,
  offerCreate,
  showPages,
}: {
  app: AppKey;
  access: AppAccess;
  pathname: string;
  offerCreate: boolean;
  showPages: boolean;
}) {
  const [open, setOpen] = useState(false);
  const steward = useOptionalStewardCommunity();
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="lg:hidden">
          <Menu aria-hidden="true" />
          <span className="sr-only">Open menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[min(20rem,85vw)] gap-6 p-0">
        <SheetHeader className="border-b border-border/70 px-5 py-4">
          <SheetTitle className="font-serif text-2xl font-normal tracking-tight">
            NatureX {APPS[app].name}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Pages, communities and apps
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 overflow-y-auto overscroll-contain px-3 pb-6">
          {app === "steward" && steward?.active && (
            <MenuSection title="Community">
              <CommunitySwitcher className="w-full max-w-none" />
            </MenuSection>
          )}
          {showPages && (
            <AppNav
              app={app}
              pathname={pathname}
              layout="stack"
              onNavigate={close}
            />
          )}
          {(access.apps.some((a) => a !== app) || offerCreate) && (
            <MenuSection title="Apps">
              <AppSwitcher
                current={app}
                access={access}
                layout="stack"
                onNavigate={close}
              />
              {offerCreate && (
                <CreateCommunityLink
                  className="w-full justify-start"
                  onNavigate={close}
                />
              )}
            </MenuSection>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MenuSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 border-t border-border/70 px-2 pt-4 first:border-t-0 first:pt-0">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      {children}
    </div>
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
