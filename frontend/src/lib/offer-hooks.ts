"use client";

/**
 * Opening offers sent for review (ADR-0008 §5): the community sends its terms, the Reviewer
 * approves (which launches the offer) or sends them back with a note.
 */
import { unwrap } from "./api/errors";
import type {
  IpoLaunch,
  IpoOut,
  ListingOffer,
  OfferOut,
  PendingOffer,
} from "./api/types";
import { queryKeys, type DataLayer } from "./data-layer";
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
  cache.invalidate(["offers"]);
  cache.invalidate(["community"]);
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

/** Approve an offer: it launches, and the site opens on the Marketplace. */
export function useApproveOffer(assetId: string): MutationResult<void, IpoOut> {
  return useApiMutation(
    (api) =>
      unwrap(
        api.POST("/admin/assets/{asset_id}/offer/approve", {
          params: { path: { asset_id: assetId } },
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

/** Send an offer back to its community with a note. */
export function useSendBackOffer(
  assetId: string,
): MutationResult<string, ListingOffer> {
  return useApiMutation(
    (api, note: string) =>
      unwrap(
        api.POST("/admin/assets/{asset_id}/offer/send-back", {
          params: { path: { asset_id: assetId } },
          body: { note },
        }),
      ),
    { onSuccess: (_out, _vars, layer) => afterOfferChange(assetId, layer) },
  );
}
