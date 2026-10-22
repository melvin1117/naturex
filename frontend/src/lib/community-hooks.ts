"use client";

/**
 * Steward home and community management hooks (T63). Kept apart from `hooks.ts` so the
 * Steward tasks built in parallel don't edit the same file; they follow its conventions.
 */
import { useEffect, useRef } from "react";

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

/** At most one summary refetch this often while trades tick in. */
export const SUMMARY_TICK_REFRESH_MS = 3_000;

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
  {
    live = "all",
  }: {
    /**
     * Which live events refetch it: "status" skips trades (whose prices only the home shows);
     * "off" where another component on the page already listens, so one event costs one fetch.
     */
    live?: "all" | "status" | "off";
  } = {},
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
  const enabled = Boolean(communityId) && live !== "off";
  // A burst of trades costs one refetch per `SUMMARY_TICK_REFRESH_MS`, not one per tick.
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetch = query.refetch;
  useEffect(
    () => () => {
      if (tickTimer.current) clearTimeout(tickTimer.current);
      tickTimer.current = null;
    },
    [refetch],
  );
  useLiveEvent(
    "price_tick",
    ({ payload }) => {
      if (!ours(payload.asset_id) || tickTimer.current) return;
      tickTimer.current = setTimeout(() => {
        tickTimer.current = null;
        void refetch();
      }, SUMMARY_TICK_REFRESH_MS);
    },
    { enabled: enabled && live === "all" },
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

/** A community's public profile (`GET /communities/{id}`): the settings page's form. */
export function useCommunity(
  communityId: string | undefined,
): QueryResult<CommunityOut> {
  const id = communityId ?? "";
  return useApiQuery(
    queryKeys.communityProfile(id),
    (api, signal) =>
      unwrap(
        api.GET("/communities/{community_id}", {
          params: { path: { community_id: id } },
          signal,
        }),
      ),
    { enabled: Boolean(communityId) },
  );
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
        // The profile, the home and the members: every query of this community.
        layer.cache.invalidate(queryKeys.community(communityId));
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
