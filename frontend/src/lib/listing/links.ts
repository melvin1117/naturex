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

/** Where a community's listings are: its page, every site by where it stands. */
export function listingsHref(communityId: string | null): string {
  return withCommunity("/steward", communityId);
}

export function stewardHomeHref(communityId: string | null): string {
  return withCommunity("/steward", communityId);
}

/** A rated listing's step in the listing flow (ADR-0008 §5): its proof, or its offer. */
export type ListingStep = "details" | "prove" | "offer";

function flowHref(
  assetId: string,
  communityId: string | null,
  step: ListingStep,
): string {
  const params = new URLSearchParams();
  if (communityId) params.set("community", communityId);
  params.set("asset", assetId);
  params.set("step", step);
  return `/steward/list?${params.toString()}`;
}

/** Where a listed site's opening offer is set and sent for review: the flow's Offer step. */
export function ipoHref(assetId: string, communityId: string | null): string {
  return flowHref(assetId, communityId, "offer");
}

/** Where a listing's land documents go: the flow's Prove step. */
export function verifyHref(
  assetId: string,
  communityId: string | null,
): string {
  return flowHref(assetId, communityId, "prove");
}
