"use client";

import { Menu } from "lucide-react";
import Link from "@/components/app-link";
import { useInSandbox, usePathname } from "@/lib/nav";
import { useId, useState, type ReactNode } from "react";
import { cn } from "cn";

import { AccountMenu } from "@/components/account-menu";
import { Lockup } from "@/components/brand";
import { PageIcon } from "@/components/shell/app-icons";
import {
  AppMenu,
  AppSwitcher,
  CreateCommunityLink,
  useAppAccess,
} from "@/components/shell/app-switcher";
import { SANDBOX_LINE, SandboxStrip } from "@/components/shell/sandbox-strip";
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
import { useCommunityHomeUpdates } from "@/lib/home-updates";
import {
  APP_NAV,
  APPS,
  isActive,
  type AppAccess,
  type AppKey,
} from "@/lib/navigation";

/** The Steward app's home, which carries a dot while it has updates the member hasn't seen. */
const STEWARD_HOME = APPS.steward.href;

/**
 * The shell header of the Exchange, the Steward app and the control room (T62), as the brand
 * guidelines' app bar (chapter 12): the lockup, a hairline, the app's name (the app switcher
 * when there's another app to open), the pages, then the tools and the account. Above it sits
 * the sandbox strip; in a visitor's sandbox, the sandbox bar instead. Navigation follows the
 * account's roles (`useAppAccess`); below `lg` the pages, apps and communities move into a
 * menu sheet. `tools` holds app-specific buttons (Ask Bea, alerts).
 */
export function AppHeader({ app, tools }: { app: AppKey; tools?: ReactNode }) {
  const pathname = usePathname();
  const access = useAppAccess();
  const steward = useOptionalStewardCommunity();
  const offerCreate = access.canCreateCommunity && app !== "steward";
  // An account without a community gets the Steward app's empty state on every page there.
  const showPages = !(app === "steward" && access.canCreateCommunity);
  const href = steward?.href ?? ((path: string) => path);
  const homeUpdates = useCommunityHomeUpdates(
    app === "steward" && showPages ? steward?.active?.id : undefined,
    pathname === STEWARD_HOME,
  );
  const updates = homeUpdates ? [STEWARD_HOME] : [];
  const inSandbox = useInSandbox();

  return (
    <>
      {/* The strip rides inside the sticky header, so the sandbox line never scrolls away. */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
        {!inSandbox && <SandboxStrip />}
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-x-3 px-4 sm:px-6 lg:gap-x-8">
          <div className="flex min-w-0 shrink-0 items-center gap-3">
            <Link
              href={href(APPS[app].href)}
              className="shrink-0 rounded-md"
              aria-label={`WildWorth ${APPS[app].name}`}
            >
              <Lockup size={24} />
            </Link>
            <span
              aria-hidden="true"
              className="hidden h-5 w-px bg-border sm:block"
            />
            <AppMenu
              current={app}
              access={access}
              offerCreate={offerCreate}
              className="hidden sm:inline-flex"
            />
            {app === "steward" && steward?.active && (
              <div className="hidden min-w-0 items-center gap-2 lg:flex">
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
              updates={updates}
              className="hidden lg:block"
            />
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {tools}
            <AccountMenu />
            <MobileMenu
              app={app}
              access={access}
              pathname={pathname}
              href={href}
              offerCreate={offerCreate}
              showPages={showPages}
              updates={updates}
            />
          </div>
        </div>
      </header>
    </>
  );
}

function AppNav({
  app,
  pathname,
  href,
  layout = "row",
  updates = [],
  className,
  onNavigate,
}: {
  app: AppKey;
  pathname: string;
  href: (path: string) => string;
  layout?: "row" | "stack";
  /** Pages with updates the member hasn't seen: a dot, described as "New updates". */
  updates?: readonly string[];
  className?: string;
  onNavigate?: () => void;
}) {
  const updatesId = useId();
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
          const updated = updates.includes(item.href);
          return (
            <li key={item.href}>
              <Link
                href={href(item.href)}
                data-tour={layout === "row" ? item.tour : undefined}
                aria-current={active ? "page" : undefined}
                aria-describedby={updated ? updatesId : undefined}
                onClick={onNavigate}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors",
                  layout === "stack" && "flex h-11 w-full",
                  active
                    ? "bg-card text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <PageIcon
                  href={item.href}
                  size={16}
                  className={cn(
                    "shrink-0",
                    layout === "row" && "hidden xl:block",
                  )}
                />
                {item.label}
                {updated && <UpdatesDot />}
              </Link>
              {updated && <UpdatesNote id={updatesId} />}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The dot marking updates the member hasn't seen; `UpdatesNote` says it in words. */
function UpdatesDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-updates-dot=""
      className={cn("ml-2 size-2 shrink-0 rounded-full bg-clay", className)}
    />
  );
}

/** "New updates", the description of the control with the dot (outside it, so not its name). */
function UpdatesNote({ id }: { id: string }) {
  return (
    <span id={id} className="sr-only">
      New updates
    </span>
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
  updates,
}: {
  app: AppKey;
  access: AppAccess;
  pathname: string;
  href: (path: string) => string;
  offerCreate: boolean;
  showPages: boolean;
  updates: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const steward = useOptionalStewardCommunity();
  const close = () => setOpen(false);
  const updatesId = useId();
  const updated = showPages && updates.length > 0;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-11 lg:hidden"
          aria-describedby={updated ? updatesId : undefined}
        >
          <Menu aria-hidden="true" />
          <span className="sr-only">Open menu</span>
          {updated && (
            <UpdatesDot className="absolute top-2.5 right-2.5 ml-0 ring-2 ring-background" />
          )}
        </Button>
      </SheetTrigger>
      {updated && <UpdatesNote id={updatesId} />}
      <SheetContent side="right" className="w-[min(20rem,85vw)] gap-6 p-0">
        <SheetHeader className="border-b border-border/70 px-5 py-4">
          <SheetTitle className="font-serif text-2xl font-normal tracking-tight">
            WildWorth {APPS[app].name}
          </SheetTitle>
          <SheetDescription
            className={app === "exchange" ? "text-xs" : "sr-only"}
          >
            {app === "exchange" ? SANDBOX_LINE : "Pages, communities and apps"}
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
              updates={updates}
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
