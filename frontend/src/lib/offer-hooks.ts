"use client";

/**
 * Opening offers sent for review (ADR-0008 §5): the community sends its terms, the Reviewer
 * approves (which launches the offer) or sends them back with a note.
 */
import { unwrap, type ApiError } from "./api/errors";
import type {
  IpoLaunch,
  IpoOut,
  ListingOffer,
  OfferOut,
  PendingOffer,
} from "./api/types";
import { queryKeys, type DataLayer } from "./data-layer";
import { blockedExplanation, needsVerification } from "./ipo";
import {
  useApiMutation,
  useApiQuery,
  useWorld,
  type MutationResult,
  type QueryResult,
} from "./hooks";

/** After an offer moves: the listing, its community's summary, the queue and the Marketplace. */
function afterOfferChange(assetId: string, { cache }: DataLayer): void {
  cache.invalidate(queryKeys.asset(assetId));
  cache.invalidate(queryKeys.ipoPreviews(assetId));
  cache.invalidate(queryKeys.pendingOffersAll());
  cache.invalidate(queryKeys.communityAll());
  cache.invalidate(queryKeys.assets());
}

/** Send (or send again) the community's opening offer for review. */
export function useSendOffer(
  assetId: string,
): MutationResult<IpoLaunch, OfferOut> {
  return useApiMutation(
    (api, body: IpoLaunch) =>
      unwrap(
        api.POST("/assets/{asset_id}/offer", {
          params: { path: { asset_id: assetId } },
          body,
        }),
      ),
    { onSuccess: (_out, _vars, layer) => afterOfferChange(assetId, layer) },
  );
}

/** The offers waiting in this sandbox, oldest first (the Reviewer's). */
export function usePendingOffers({
  enabled = true,
}: { enabled?: boolean } = {}): QueryResult<PendingOffer[]> {
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  return useApiQuery(
    queryKeys.pendingOffers(meId),
    (api, signal) => unwrap(api.GET("/admin/offers", { signal })),
    { enabled: enabled && meId !== null },
  );
}

/**
 * Approve the offer sent at `sentAt` (the one the Reviewer read): it launches, and the site
 * opens on the Marketplace. Sent again or decided since, it's refused `offer_changed`.
 */
export function useApproveOffer(
  assetId: string,
): MutationResult<string, IpoOut> {
  return useApiMutation(
    (api, sentAt: string) =>
      unwrap(
        api.POST("/admin/assets/{asset_id}/offer/approve", {
          params: { path: { asset_id: assetId } },
          body: { sent_at: sentAt },
        }),
      ),
    {
      onSuccess: (_out, _vars, layer) => {
        afterOfferChange(assetId, layer);
        layer.cache.invalidate(queryKeys.prices(assetId));
        layer.cache.invalidate(queryKeys.ledger(assetId));
      },
    },
  );
}

/** Send the offer sent at `sentAt` back to its community with a note. */
export function useSendBackOffer(
  assetId: string,
): MutationResult<{ sentAt: string; note: string }, ListingOffer> {
  return useApiMutation(
    (api, { sentAt, note }: { sentAt: string; note: string }) =>
      unwrap(
        api.POST("/admin/assets/{asset_id}/offer/send-back", {
          params: { path: { asset_id: assetId } },
          body: { sent_at: sentAt, note },
        }),
      ),
    { onSuccess: (_out, _vars, layer) => afterOfferChange(assetId, layer) },
  );
}

/** A refused decision on an offer, in words. */
export function offerDecisionFailure(error: ApiError): string {
  switch (error.code) {
    case "offer_changed":
      return "The community changed this offer since you opened it. Read the new terms before deciding.";
    case "offer_not_sent":
      return "This offer isn't waiting any more: the community may have withdrawn it, or another reviewer decided it.";
    case "ipo_already_launched":
      return "It's already on the Marketplace.";
    case "conflict_of_interest":
      return "You're in this site's community, so another reviewer decides it.";
    case "run_in_progress":
      return "A rating is running for this site. Approve it once it's done.";
  }
  if (error.code && needsVerification(error.code))
    return "Its verification was revoked, so it can't open yet. Send it back with a note.";
  if (error.code === "ipo_price_too_low" || error.code === "ipo_price_too_high")
    return `${blockedExplanation(error.code).title}. Send it back so the community can change how many units it issues.`;
  return error.message;
}
