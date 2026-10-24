"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import Link from "@/components/app-link";
import { cn } from "cn";

import { AppIcon } from "@/components/shell/app-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMyCommunities, useWorld } from "@/lib/hooks";
import {
  APPS,
  appAccess,
  switchTargets,
  type AppAccess,
  type AppKey,
} from "@/lib/navigation";
import { usePrototype } from "@/lib/prototype/store";

/**
 * Which apps this visitor is offered (`appAccess`): from `world.me` and `GET /me/communities`,
 * or the scripted demo for anonymous visitors who chose it (T61). If the communities can't be
 * read, the Steward app is still offered; its error screen explains and retries. The UI hides
 * what the account can't do; the backend still refuses it.
 */
export function useAppAccess(): AppAccess {
  const { world } = useWorld();
  const communities = useMyCommunities();
  const { demo } = usePrototype();
  const me = world?.me;
  return appAccess({
    me,
    communities: me ? communities.data : undefined,
    communitiesFailed: communities.status === "error",
    prototypeDemo: demo,
  });
}

/**
 * Links to the other apps the visitor may open (T62): the Steward app for community members,
 * Admin for platform admins, and the Exchange from either. `layout="stack"` is for the mobile
 * menu. Renders nothing when there's nowhere else to go.
 */
export function AppSwitcher({
  current,
  access,
  layout = "row",
  className,
  onNavigate,
}: {
  current: AppKey;
  access: AppAccess;
  layout?: "row" | "stack";
  className?: string;
  onNavigate?: () => void;
}) {
  const targets = switchTargets(current, access);
  if (targets.length === 0) return null;
  return (
    <nav aria-label="Switch app" className={className}>
      <ul
        className={cn(
          "flex gap-1.5",
          layout === "stack" ? "flex-col items-stretch" : "items-center",
        )}
      >
        {targets.map((app) => (
          <li key={app}>
            <Button
              asChild
              variant="outline"
              size="sm"
              className={cn(layout === "stack" && "w-full justify-start")}
            >
              <Link href={APPS[app].href} onClick={onNavigate}>
                <AppIcon app={app} />
                {APPS[app].switchLabel}
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The investor's way into the Steward app: its empty state leads to creating a community. */
export function CreateCommunityLink({
  className,
  onNavigate,
}: {
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <Button asChild variant="outline" size="sm" className={className}>
      <Link href={APPS.steward.href} onClick={onNavigate}>
        <Plus aria-hidden="true" />
        Create a community
      </Link>
    </Button>
  );
}

/**
 * The app's name beside the lockup, as in the guidelines' app bar: after a hairline, quiet and
 * regular. When the visitor can open another app (or create a community) the name is the
 * switcher: a menu of their apps, the current one checked. Otherwise it's just the name.
 */
export function AppMenu({
  current,
  access,
  offerCreate,
  className,
}: {
  current: AppKey;
  access: AppAccess;
  offerCreate: boolean;
  className?: string;
}) {
  const name = APPS[current].name;
  const others = switchTargets(current, access);
  const label =
    "text-[15px] font-normal whitespace-nowrap text-muted-foreground";
  if (others.length === 0 && !offerCreate)
    return <span className={cn(label, "px-1", className)}>{name}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            label,
            "-mx-1 gap-1 rounded-full px-2.5 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
            className,
          )}
        >
          {name}
          <span className="sr-only">, switch app</span>
          <ChevronDown className="size-3.5 opacity-70" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60 rounded-2xl p-1.5">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          WildWorth apps
        </DropdownMenuLabel>
        {access.apps.map((app) => (
          <DropdownMenuItem key={app} asChild className="gap-2.5 rounded-xl">
            <Link
              href={APPS[app].href}
              // "true", not "page": you may be on any of the app's pages.
              aria-current={app === current ? "true" : undefined}
            >
              <AppIcon app={app} className="size-[18px]" />
              <span className="flex-1">{APPS[app].switchLabel}</span>
              {app === current && (
                <Check className="size-4" aria-hidden="true" />
              )}
            </Link>
          </DropdownMenuItem>
        ))}
        {offerCreate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="gap-2.5 rounded-xl">
              <Link href={APPS.steward.href}>
                <Plus className="size-[18px]" aria-hidden="true" />
                Create a community
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
