"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/**
 * What a site page opens over itself instead of sending the visitor elsewhere (ADR-0008): the
 * Agent Trace, or the Proof of Life drawer on one of its tabs. The page's `?tab=` names it, so
 * the links that already point at a site's report, Record or news keep working.
 */
export const SITE_DRAWERS = [
  "trace",
  "report",
  "ledger",
  "verification",
  "photos",
  "sources",
] as const;
export type SiteDrawer = (typeof SITE_DRAWERS)[number];

/** The Proof of Life drawer's tabs, in order. */
export const RECORD_TABS = [
  "report",
  "ledger",
  "verification",
  "photos",
  "sources",
] as const satisfies readonly SiteDrawer[];
export type RecordTab = (typeof RECORD_TABS)[number];

export const RECORD_TAB_LABEL: Record<RecordTab, string> = {
  report: "Proof of Life",
  ledger: "The Record",
  verification: "Verification",
  photos: "Field photos",
  sources: "Data sources",
};

/** Where "Back this site" is on the page. */
export const BACK_THIS_SITE = "back-this-site";

/** Places on the page itself that a `?tab=` can point at: scrolled to, never a drawer. */
export const SITE_ANCHORS: Record<string, string> = {
  news: "what-happened",
  price: "price",
};

export function parseSiteDrawer(tab: string | null): SiteDrawer | null {
  return SITE_DRAWERS.find((d) => d === tab) ?? null;
}

export function isRecordTab(drawer: SiteDrawer | null): drawer is RecordTab {
  return RECORD_TABS.some((t) => t === drawer);
}

/** The URL with `?tab=` set to `drawer` (or dropped), keeping the rest and the hash. */
export function withSiteDrawer(
  href: string,
  drawer: SiteDrawer | null,
): string {
  const url = new URL(href);
  if (drawer) url.searchParams.set("tab", drawer);
  else url.searchParams.delete("tab");
  if (!drawer || drawer !== "report") url.searchParams.delete("version");
  return `${url.pathname}${url.search}${drawer ? url.hash : ""}`;
}

/**
 * The open drawer, from `?tab=` on arrival and whenever the URL changes under the page (Bea's
 * source chip, a ledger link); opening and closing write it back without a navigation.
 */
export function useSiteDrawer() {
  const params = useSearchParams();
  const tab = params.get("tab");
  const [drawer, setDrawer] = useState<SiteDrawer | null>(() =>
    parseSiteDrawer(tab),
  );
  const [seen, setSeen] = useState(tab);
  if (tab !== seen) {
    setSeen(tab);
    setDrawer(parseSiteDrawer(tab));
  }
  // A link followed in place (the verification panel's ledger link pushes `?tab=ledger#…` and
  // announces the hash) moves the drawer too, before the router catches up.
  useEffect(() => {
    const follow = () =>
      setDrawer(
        parseSiteDrawer(new URL(window.location.href).searchParams.get("tab")),
      );
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const show = useCallback((next: SiteDrawer | null) => {
    setDrawer(next);
    window.history.replaceState(
      null,
      "",
      withSiteDrawer(window.location.href, next),
    );
  }, []);
  return { drawer, tab, show };
}
