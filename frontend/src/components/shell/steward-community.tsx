"use client";

import { RefreshCwIcon, Sprout, TriangleAlertIcon } from "lucide-react";
import Link from "@/components/app-link";
import { useSearchParams } from "next/navigation";
import { usePathname, useRouter } from "@/lib/nav";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { RouteSkeleton } from "@/components/page-skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CreateCommunityForm } from "@/components/steward/community-form";
import { FocusFirstHeading } from "@/components/steward/focus-first-heading";
import { NotACommunityMember } from "@/components/steward/not-a-member";
import {
  COMMUNITY_PARAM,
  readRememberedCommunity,
  rememberCommunity,
  subscribeRememberedCommunity,
} from "@/lib/active-community";
import type { CommunityOut, MyCommunity } from "@/lib/api/types";
import { isApiAssetId } from "@/lib/asset-detail";
import {
  useAsset,
  useMyCommunities,
  useWorld,
  type QueryResult,
} from "@/lib/hooks";
import { pickCommunity, withCommunity } from "@/lib/navigation";

interface StewardCommunityValue {
  query: QueryResult<MyCommunity[]>;
  /** The signed-in account's communities; empty until loaded, or for anonymous visitors. */
  communities: MyCommunity[];
  /** The community the Steward app shows; null until loaded, without one, or when anonymous. */
  active: MyCommunity | null;
  /** Show another community: puts it in the URL and remembers it for this account. */
  select: (id: string) => void;
  /** A Steward app link that keeps the shown community (`?community=<id>`). */
  href: (path: string) => string;
}

const StewardCommunityContext = createContext<StewardCommunityValue | null>(
  null,
);

/**
 * The Steward app's communities (`GET /me/communities`) and the one it shows: the
 * `?community=` parameter, else the one remembered for this account, else the first; any of
 * them only if the account is still a member. T63, T33 and T64 read it with
 * `useStewardCommunity()`.
 */
export function StewardCommunityProvider({
  children,
}: {
  children: ReactNode;
}) {
  // useSearchParams opts a static page out of server rendering up to the nearest Suspense
  // boundary: the server renders the same shell without the parameter instead.
  return (
    <Suspense
      fallback={
        <CommunityProvider communityParam={null}>{children}</CommunityProvider>
      }
    >
      <CommunityProviderFromUrl>{children}</CommunityProviderFromUrl>
    </Suspense>
  );
}

function CommunityProviderFromUrl({ children }: { children: ReactNode }) {
  const communityParam = useSearchParams().get(COMMUNITY_PARAM);
  return (
    <CommunityProvider communityParam={communityParam}>
      {children}
    </CommunityProvider>
  );
}

function CommunityProvider({
  communityParam,
  children,
}: {
  communityParam: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  const query = useMyCommunities();
  // Read during render (null on the server), so the first client render already shows it.
  const remembered = useSyncExternalStore(
    subscribeRememberedCommunity,
    () => (meId ? readRememberedCommunity(meId) : null),
    () => null,
  );

  const communities = useMemo(
    () => (meId ? (query.data ?? []) : []),
    [meId, query.data],
  );
  const active = pickCommunity(communities, [communityParam, remembered]);
  const activeId = active?.id ?? null;

  const select = useCallback(
    (id: string) => {
      if (meId) rememberCommunity(meId, id);
      const params = new URLSearchParams(window.location.search);
      params.set(COMMUNITY_PARAM, id);
      params.delete("new"); // Start a community (`?new=1`) gives way to the new one.
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [meId, pathname, router],
  );
  const href = useCallback(
    (path: string) => withCommunity(path, activeId),
    [activeId],
  );

  const value = useMemo<StewardCommunityValue>(
    () => ({ query, communities, active, select, href }),
    [query, communities, active, select, href],
  );

  return (
    <StewardCommunityContext.Provider value={value}>
      {children}
    </StewardCommunityContext.Provider>
  );
}

/** A community just created from Communities: its page takes focus once when it opens. */
let justCreated: string | null = null;

export function markJustCreated(id: string): void {
  justCreated = id;
}

/** Whether `id` was just created here; true once. */
export function takeJustCreated(id: string): boolean {
  if (justCreated !== id) return false;
  justCreated = null;
  return true;
}

/** Null outside the Steward app (no provider). */
export function useOptionalStewardCommunity(): StewardCommunityValue | null {
  return useContext(StewardCommunityContext);
}

export function useStewardCommunity(): StewardCommunityValue {
  const value = useContext(StewardCommunityContext);
  if (!value) {
    throw new Error(
      "useStewardCommunity needs <StewardCommunityProvider> (app/steward/layout.tsx).",
    );
  }
  return value;
}

/** The asset a Steward asset page (`/steward/assets/<id>/...`) is about; null elsewhere. */
export function stewardAssetId(pathname: string | null): string | null {
  const match = /^\/steward\/assets\/([^/]+)(?:\/|$)/.exec(pathname ?? "");
  return match ? match[1] : null;
}

/**
 * What a signed-in account sees in the Steward app: its pages once it belongs to a community,
 * else "Start a community" with the create form (T63). On a site's pages
 * (`/steward/assets/<id>/...`), an account outside the community that lists the site is told
 * so instead (T74); the API refuses its actions either way. Anonymous visitors only get here
 * in the scripted demo (`RequireAccount`).
 */
export function StewardGate({ children }: { children: ReactNode }) {
  const { world } = useWorld();
  const { query, communities } = useStewardCommunity();
  const assetId = stewardAssetId(usePathname());
  // The account whose community was just created here: the page that replaces the form takes
  // focus once. Cleared if another account signs in (signing out unmounts the gate).
  const [createdBy, setCreatedBy] = useState<string | null>(null);
  const meId = world?.me?.id ?? null;
  if (createdBy !== null && createdBy !== meId) setCreatedBy(null);

  if (world?.me == null) return children;

  if (communities.length === 0) {
    if (query.status === "error") {
      return (
        <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>We couldn&apos;t load your communities</AlertTitle>
            <AlertDescription>
              <p>{query.error?.message}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void query.refetch()}
              >
                <RefreshCwIcon aria-hidden="true" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      );
    }

    if (query.status !== "success") {
      return <GateLoading>Loading your communities…</GateLoading>;
    }

    if (assetId === null) {
      return <StartCommunity onCreated={() => setCreatedBy(meId)} />;
    }
  }

  if (assetId !== null) {
    return (
      <AssetMembershipGate assetId={assetId} meId={world.me.id}>
        {children}
      </AssetMembershipGate>
    );
  }
  if (createdBy === meId)
    return <FocusFirstHeading>{children}</FocusFirstHeading>;
  return children;
}

function GateLoading({ children }: { children: string }) {
  return <RouteSkeleton label={children} />;
}

/**
 * A site's Steward pages, for members of the community that lists it. A missing site or a
 * failed load is left to the page, which explains it.
 */
function AssetMembershipGate({
  assetId,
  meId,
  children,
}: {
  assetId: string;
  meId: string;
  children: ReactNode;
}) {
  const { communities, href } = useStewardCommunity();
  const validId = isApiAssetId(assetId);
  const asset = useAsset(validId ? assetId : undefined);

  if (!validId || asset.error) return children;
  if (!asset.data) return <GateLoading>Checking this site…</GateLoading>;

  const listedBy = asset.data.community_id;
  if (listedBy && communities.some((c) => c.id === listedBy)) return children;
  return (
    <NotACommunityMember
      assetId={assetId}
      name={asset.data.name}
      meId={meId}
      homeHref={communities.length > 0 ? href("/steward") : null}
    />
  );
}

/**
 * Start a community: what it's for, and the form. Shown to someone in none, and from the
 * Communities page (`?new=1`), with `back` leading to it. The new community opens next.
 */
export function StartCommunity({
  onCreated,
  back,
}: {
  onCreated: (community: CommunityOut) => void;
  back?: { href: string; label: string };
}) {
  const { select } = useStewardCommunity();
  return (
    <section
      aria-labelledby="steward-empty-title"
      className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-20"
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start">
        <div>
          <span
            aria-hidden="true"
            className="grid size-12 place-items-center rounded-2xl bg-lime/40 text-lime-ink"
          >
            <Sprout className="size-6" />
          </span>
          <h1
            id="steward-empty-title"
            className="mt-6 font-serif text-4xl tracking-tight text-balance sm:text-5xl"
          >
            Start a community
          </h1>
          <p className="mt-4 max-w-prose text-pretty text-muted-foreground">
            A community looks after its land. Create one to list that land, get
            it rated and grow a fund from what supporters pay in.
          </p>
          <ol className="mt-6 space-y-3 text-sm">
            {[
              "Name your community",
              "Draw your land and get it rated in minutes",
              "Send your offer: once approved, supporters can back it",
            ].map((step, i) => (
              <li key={step} className="flex items-center gap-3">
                <span className="tabular grid size-6 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <Button asChild variant="outline" className="mt-6">
            <Link href={back?.href ?? "/"}>
              {back?.label ?? "Back to the Marketplace"}
            </Link>
          </Button>
        </div>
        <div className="rounded-[1.75rem] bg-card p-6 shadow-lift sm:p-8">
          <h2 className="text-lg font-semibold">Create your community</h2>
          <p className="mt-1 mb-5 text-sm text-muted-foreground">
            You&apos;ll be its owner.
          </p>
          <CreateCommunityForm
            onCreated={(community) => {
              select(community.id);
              onCreated(community);
            }}
          />
        </div>
      </div>
    </section>
  );
}
