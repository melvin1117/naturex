/**
 * Communities' links: which community a page shows (`?community=`) and the role words. Pure,
 * so the rules are unit-tested. The sandbox's own pages are in `lib/sandbox-nav.ts`.
 */
import { COMMUNITY_PARAM } from "./active-community";
import type { MyCommunity } from "./api/types";

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
