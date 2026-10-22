/**
 * The two apps and the control room (ADR-0005 §5, T62): their navigation, and which of them a
 * visitor is offered. Pure, so the role rules are unit-tested. This only decides what the UI
 * shows; the backend authorizes every request.
 */
import { COMMUNITY_PARAM } from "./active-community";
import type { MeOut, MyCommunity } from "./api/types";

export type AppKey = "exchange" | "steward" | "admin";

export const APPS: Record<
  AppKey,
  { name: string; switchLabel: string; href: string }
> = {
  exchange: { name: "Exchange", switchLabel: "Exchange", href: "/" },
  steward: { name: "Steward", switchLabel: "Steward app", href: "/steward" },
  admin: { name: "Control room", switchLabel: "Admin", href: "/admin" },
};

export interface NavItem {
  href: string;
  label: string;
  /** Guided-tour anchor (`data-tour`). */
  tour?: string;
}

export const APP_NAV: Record<AppKey, NavItem[]> = {
  exchange: [
    { href: "/", label: "Marketplace", tour: "nav-marketplace" },
    { href: "/portfolio", label: "Your stakes", tour: "nav-portfolio" },
  ],
  steward: [
    { href: "/steward", label: "Community home" },
    { href: "/steward/listings", label: "Listings" },
    { href: "/steward/list", label: "List land", tour: "nav-list" },
  ],
  admin: [
    { href: "/admin", label: "Time Machine" },
    { href: "/admin/verifications", label: "Verifications" },
  ],
};

/** An app's home matches only itself; other items match their subpaths too. */
export function isActive(pathname: string, href: string): boolean {
  if (Object.values(APPS).some((app) => app.href === href))
    return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface AppAccess {
  /** Apps this visitor may open, in display order. The Exchange is open to everyone. */
  apps: AppKey[];
  /** Signed in without a community: offer "Create a community" (the Steward app's empty state). */
  canCreateCommunity: boolean;
}

/**
 * Navigation follows the signed-in account's roles:
 * - anonymous: the Exchange only (plus the Steward app in the scripted prototype demo, T61);
 * - signed in without a community: the Exchange and "Create a community";
 * - a community owner or steward: the Exchange and the Steward app;
 * - a platform admin: also Admin.
 * `communities` is undefined until `GET /me/communities` answers; until then nothing that
 * depends on it shows, so the header never offers the wrong thing. If it failed
 * (`communitiesFailed`), the Steward app is still offered: its error screen explains and retries.
 */
export function appAccess({
  me,
  communities,
  communitiesFailed = false,
  prototypeDemo = false,
}: {
  me: MeOut | null | undefined;
  communities: readonly MyCommunity[] | undefined;
  communitiesFailed?: boolean;
  prototypeDemo?: boolean;
}): AppAccess {
  if (!me) {
    return {
      apps: prototypeDemo ? ["exchange", "steward"] : ["exchange"],
      canCreateCommunity: false,
    };
  }
  const apps: AppKey[] = ["exchange"];
  if (communities?.length || (communities === undefined && communitiesFailed))
    apps.push("steward");
  if (me.is_admin) apps.push("admin");
  return { apps, canCreateCommunity: communities?.length === 0 };
}

/** The other apps to offer from `current`, in display order. */
export function switchTargets(current: AppKey, access: AppAccess): AppKey[] {
  return access.apps.filter((app) => app !== current);
}

/**
 * The community the Steward app shows: the first preferred ID the account is still a member of
 * (the `?community=` parameter, then the remembered one), else its first community.
 */
export function pickCommunity(
  communities: readonly MyCommunity[],
  preferredIds: readonly (string | null | undefined)[],
): MyCommunity | null {
  for (const id of preferredIds) {
    const match = id ? communities.find((c) => c.id === id) : undefined;
    if (match) return match;
  }
  return communities[0] ?? null;
}

/** A Steward app link that keeps the shown community (`?community=<id>`). */
export function withCommunity(
  href: string,
  communityId: string | null,
): string {
  if (!communityId) return href;
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  params.set(COMMUNITY_PARAM, communityId);
  return `${path}?${params.toString()}`;
}

export const COMMUNITY_ROLE_LABEL: Record<MyCommunity["role"], string> = {
  owner: "Owner",
  steward: "Steward",
};
