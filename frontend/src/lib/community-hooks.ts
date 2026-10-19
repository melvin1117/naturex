"use client";

/**
 * Steward home and community management hooks (T63). Kept apart from `hooks.ts` so the
 * Steward tasks built in parallel don't edit the same file; they follow its conventions.
 */
import { unwrap } from "./api/errors";
import type {
  CommunityCreate,
  CommunityMember,
  CommunityOut,
  CommunitySummary,
  CommunityUpdate,
} from "./api/types";
import { queryKeys, type DataLayer } from "./data-layer";
import {
  useApiMutation,
  useApiQuery,
  useLiveEvent,
  useWorld,
  type MutationResult,
  type QueryResult,
} from "./hooks";

function meIdOf({ session }: DataLayer): string | null {
  return session.getSnapshot().world?.me?.id ?? null;
}

/**
 * The Steward home (`GET /communities/{id}/summary`): listings and their next action, the
 * wallet, holders, payouts and recommendations. Members and same-world admins only. Live: a
 * trade on one of its listings, a finished rating run or a listing status change refetches it.
 */
export function useCommunitySummary(
  communityId: string | undefined,
): QueryResult<CommunitySummary> {
  const id = communityId ?? "";
  const query = useApiQuery(
    queryKeys.communitySummary(id),
    (api, signal) =>
      unwrap(
        api.GET("/communities/{community_id}/summary", {
          params: { path: { community_id: id } },
          signal,
        }),
      ),
    { enabled: Boolean(communityId) },
  );
  const ours = (assetId: unknown) =>
    query.data?.listings.some((l) => l.asset.id === assetId) ?? false;
  const enabled = Boolean(communityId);
  useLiveEvent(
    "price_tick",
    ({ payload }) => {
      if (ours(payload.asset_id)) void query.refetch();
    },
    { enabled },
  );
  useLiveEvent(
    "rating_progress",
    ({ payload }) => {
      if (payload.step === "done" && ours(payload.asset_id))
        void query.refetch();
    },
    { enabled },
  );
  useLiveEvent(
    "listing_status",
    ({ payload }) => {
      if (payload.community_id === communityId || ours(payload.asset_id))
        void query.refetch();
    },
    { enabled },
  );
  return query;
}

/** The owner and stewards (`GET /communities/{id}/members`; members and admins only). */
export function useCommunityMembers(
  communityId: string | undefined,
): QueryResult<CommunityMember[]> {
  const id = communityId ?? "";
  return useApiQuery(
    queryKeys.communityMembers(id),
    (api, signal) =>
      unwrap(
        api.GET("/communities/{community_id}/members", {
          params: { path: { community_id: id } },
          signal,
        }),
      ),
    { enabled: Boolean(communityId) },
  );
}

/**
 * `POST /communities`: the caller becomes its owner. Refetches `/me/communities`, so the
 * shells offer the Steward app and the switcher lists it.
 */
export function useCreateCommunity(): MutationResult<
  CommunityCreate,
  CommunityOut
> {
  return useApiMutation(
    (api, body: CommunityCreate) => unwrap(api.POST("/communities", { body })),
    {
      onSuccess: (_community, _body, layer) =>
        layer.cache.invalidate(queryKeys.myCommunities(meIdOf(layer))),
    },
  );
}

/** `PATCH /communities/{id}` (owner only): only the fields sent change. */
export function useUpdateCommunity(
  communityId: string,
): MutationResult<CommunityUpdate, CommunityOut> {
  return useApiMutation(
    (api, body: CommunityUpdate) =>
      unwrap(
        api.PATCH("/communities/{community_id}", {
          params: { path: { community_id: communityId } },
          body,
        }),
      ),
    {
      onSuccess: (_community, _body, layer) => {
        layer.cache.invalidate(queryKeys.myCommunities(meIdOf(layer)));
        layer.cache.invalidate(queryKeys.communitySummary(communityId));
      },
    },
  );
}

/** Add a steward by account ID (owner only). */
export function useAddSteward(
  communityId: string,
): MutationResult<string, CommunityMember> {
  return useApiMutation(
    (api, userId: string) =>
      unwrap(
        api.POST("/communities/{community_id}/members", {
          params: { path: { community_id: communityId } },
          body: { user_id: userId },
        }),
      ),
    {
      onSuccess: (_member, _userId, { cache }) =>
        cache.invalidate(queryKeys.communityMembers(communityId)),
    },
  );
}

/** Remove a steward (owner), or leave the community (the caller's own ID). */
export function useRemoveMember(
  communityId: string,
): MutationResult<string, void> {
  return useApiMutation(
    async (api, userId: string) => {
      await unwrap(
        api.DELETE("/communities/{community_id}/members/{user_id}", {
          params: { path: { community_id: communityId, user_id: userId } },
        }),
      );
    },
    {
      onSuccess: (_done, userId, layer) => {
        layer.cache.invalidate(queryKeys.communityMembers(communityId));
        if (userId === meIdOf(layer))
          layer.cache.invalidate(queryKeys.myCommunities(meIdOf(layer)));
      },
    },
  );
}

/** The signed-in account's ID, or null. */
export function useMeId(): string | null {
  return useWorld().world?.me?.id ?? null;
}
