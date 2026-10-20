/** The listing flow's links, agreed with T63 (Steward home) and T64 (IPO screen). */
import { withCommunity } from "../navigation";

/** This page: a new listing, or `asset` to resume a draft or a listing under review. */
export function listingHref(
  communityId: string,
  assetId?: string | null,
): string {
  const params = new URLSearchParams({ community: communityId });
  if (assetId) params.set("asset", assetId);
  return `/steward/list?${params.toString()}`;
}

export function stewardHomeHref(communityId: string | null): string {
  return withCommunity("/steward", communityId);
}

/** The IPO screen (T64) for a listed asset. */
export function ipoHref(assetId: string, communityId: string | null): string {
  return withCommunity(`/steward/assets/${assetId}/ipo`, communityId);
}

/** The listing's verification screen (T70): documents, checklist and decision. */
export function verifyHref(
  assetId: string,
  communityId: string | null,
): string {
  return withCommunity(`/steward/assets/${assetId}/verify`, communityId);
}
