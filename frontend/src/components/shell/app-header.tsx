"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { cn } from "cn";

import { AccountMenu } from "@/components/account-menu";
import { Wordmark } from "@/components/proto/bits";
import {
  AppSwitcher,
  CreateCommunityLink,
  useAppAccess,
} from "@/components/shell/app-switcher";
import {
  CommunitySwitcher,
  useOptionalStewardCommunity,
} from "@/components/shell/steward-community";
import { Button } from "@/components/ui/button";
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

/**
 * The shell header of the Exchange, the Steward app and the control room (T62). Navigation
 * follows the signed-in account's roles (`useAppAccess`); from `lg` down, the pages, the app
 * switcher and the community switcher move into a menu sheet. `tools` holds app-specific
 * buttons (today the prototype's Copilot, Agent Trace and alerts).
 */
export function AppHeader({ app, tools }: { app: AppKey; tools?: ReactNode }) {
  const pathname = usePathname();
  const access = useAppAccess();
  const steward = useOptionalStewardCommunity();
  const offerCreate = access.canCreateCommunity && app !== "steward";
  // An account without a community gets the Steward app's empty state on every page there.
  const showPages = !(app === "steward" && access.canCreateCommunity);
  const href = steward?.href ?? ((path: string) => path);

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-x-3 px-4 sm:px-6 lg:gap-x-6">
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          <Link href={href(APPS[app].href)} className="shrink-0 rounded-md">
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
          <AppNav
            app={app}
            pathname={pathname}
            href={href}
            className="hidden lg:block"
          />
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {tools}
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
            href={href}
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
  href,
  layout = "row",
  className,
  onNavigate,
}: {
  app: AppKey;
  pathname: string;
  href: (path: string) => string;
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
                href={href(item.href)}
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
  href,
  offerCreate,
  showPages,
}: {
  app: AppKey;
  access: AppAccess;
  pathname: string;
  href: (path: string) => string;
  offerCreate: boolean;
  showPages: boolean;
}) {
  const [open, setOpen] = useState(false);
  const steward = useOptionalStewardCommunity();
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11 lg:hidden">
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
              href={href}
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
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-2 border-t border-border/70 px-2 pt-4 first:border-t-0 first:pt-0"
    >
      <h2
        id={id}
        className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
