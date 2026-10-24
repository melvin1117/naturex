"use client";

import { Plus, Repeat2, ShieldCheck } from "lucide-react";
import Link from "@/components/app-link";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
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
                {app === "admin" ? (
                  <ShieldCheck aria-hidden="true" />
                ) : (
                  <Repeat2 aria-hidden="true" />
                )}
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
