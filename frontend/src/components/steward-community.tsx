"use client";

import {
  ChevronsUpDown,
  RefreshCwIcon,
  Sprout,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "cn";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import type { MyCommunity } from "@/lib/api/types";
import { useMyCommunities, useWorld, type QueryResult } from "@/lib/hooks";
import { COMMUNITY_ROLE_LABEL, pickCommunity } from "@/lib/navigation";

/** Only the community ID, never account data; checked against `/me/communities` on read. */
const STORAGE_KEY = "nx-steward-community";

interface StewardCommunityValue {
  query: QueryResult<MyCommunity[]>;
  /** The signed-in account's communities; empty until loaded, or for anonymous visitors. */
  communities: MyCommunity[];
  /** The community the Steward app shows; null until loaded, without one, or when anonymous. */
  active: MyCommunity | null;
  select: (id: string) => void;
}

const StewardCommunityContext = createContext<StewardCommunityValue | null>(
  null,
);

function readPreferred(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The Steward app's communities (`GET /me/communities`) and the one it shows. The choice is
 * remembered in this browser; a community the account no longer belongs to falls back to the
 * first. T63, T33 and T64 read it with `useStewardCommunity()`.
 */
export function StewardCommunityProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { world } = useWorld();
  const query = useMyCommunities();
  const [preferred, setPreferred] = useState<string | null>(null);

  useEffect(() => {
    // Storage isn't readable during server rendering; read it once on the client.
    setPreferred(readPreferred());
  }, []);

  const select = useCallback((id: string) => {
    setPreferred(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Storage blocked: the choice lasts until the page reloads.
    }
  }, []);

  const signedIn = world?.me != null;
  const communities = useMemo(
    () => (signedIn && query.status === "success" ? (query.data ?? []) : []),
    [signedIn, query.status, query.data],
  );
  const value = useMemo<StewardCommunityValue>(
    () => ({
      query,
      communities,
      active: pickCommunity(communities, preferred),
      select,
    }),
    [query, communities, preferred, select],
  );

  return (
    <StewardCommunityContext.Provider value={value}>
      {children}
    </StewardCommunityContext.Provider>
  );
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

/**
 * The community the Steward app shows, in its header. With more than one, a menu switches
 * between them; with one, its name; with none (or anonymous), nothing.
 */
export function CommunitySwitcher({ className }: { className?: string }) {
  const steward = useOptionalStewardCommunity();
  if (!steward?.active) return null;
  const { communities, active, select } = steward;

  if (communities.length === 1) {
    return (
      <p className={cn("flex min-w-0 items-baseline gap-2 text-sm", className)}>
        <span className="sr-only">Community:</span>
        <span className="truncate font-medium">{active.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {COMMUNITY_ROLE_LABEL[active.role]}
        </span>
      </p>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("max-w-56 min-w-0 justify-between", className)}
          aria-label={`Community: ${active.name}. Switch community`}
        >
          <span className="truncate">{active.name}</span>
          <ChevronsUpDown
            aria-hidden="true"
            className="text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 rounded-2xl p-1.5">
        <DropdownMenuLabel>Your communities</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={active.id} onValueChange={select}>
          {communities.map((community) => (
            <DropdownMenuRadioItem key={community.id} value={community.id}>
              <span className="min-w-0 flex-1 truncate">{community.name}</span>
              <span className="text-xs text-muted-foreground">
                {COMMUNITY_ROLE_LABEL[community.role]}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * What a signed-in account sees in the Steward app before its pages are wired (T63): the
 * prototype pages once it belongs to a community, else an empty state that leads to creating
 * one. Anonymous visitors only get here in the scripted demo (`RequireAccount`).
 */
export function StewardGate({ children }: { children: ReactNode }) {
  const { world } = useWorld();
  const { query, communities } = useStewardCommunity();

  if (world?.me == null) return children;
  if (communities.length > 0) return children;

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
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
      >
        <Spinner aria-hidden="true" role="presentation" />
        Loading your communities…
      </div>
    );
  }

  return <CreateCommunityEmptyState />;
}

function CreateCommunityEmptyState() {
  return (
    <section
      aria-labelledby="steward-empty-title"
      className="mx-auto max-w-2xl px-4 py-16 sm:px-6 sm:py-24"
    >
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
        The Steward app is for the people who look after the land. Create a
        community to list your land, get it rated and receive what investors pay
        into its treasury. You&apos;ll be its owner and can invite stewards.
      </p>
      <p className="mt-6 max-w-prose rounded-2xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
        Creating a community from here is coming next. Until then, the Steward
        app stays empty for your account.
      </p>
      <Button asChild variant="outline" className="mt-8">
        <Link href="/">Back to the Exchange</Link>
      </Button>
    </section>
  );
}
