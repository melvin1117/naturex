/**
 * The two apps and the control room (ADR-0005 §5, T62): their navigation, and which of them a
 * visitor is offered. Pure, so the role rules are unit-tested. This only decides what the UI
 * shows; the backend authorizes every request.
 */
import { COMMUNITY_PARAM } from "./active-community";
import type { MyCommunity } from "./api/types";

export type AppKey = "exchange" | "steward" | "admin";

export const APPS: Record<
  AppKey,
  { name: string; switchLabel: string; href: string }
> = {
  exchange: { name: "Exchange", switchLabel: "Exchange", href: "/" },
  steward: { name: "Stewards", switchLabel: "Stewards", href: "/steward" },
  admin: { name: "Control room", switchLabel: "Control room", href: "/admin" },
};

/** An app's home matches only itself; other items match their subpaths too. */
export function isActive(pathname: string, href: string): boolean {
  if (Object.values(APPS).some((app) => app.href === href))
    return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
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
