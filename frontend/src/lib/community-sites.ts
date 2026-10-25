/**
 * A community's sites as its page shows them (ADR-0008 §5): where each one stands, in a few
 * words, and the one place it leads. Pure, so the rules are unit tested; what a listing waits
 * for comes from the API (`next_action`, `offer`), never guessed here.
 */
import type { ListingSummary } from "./api/types";
import { ipoHref, listingHref, verifyHref } from "./listing/links";
import { assetHref } from "./trade";

export type SiteTone = "draft" | "working" | "attention" | "ready" | "live";

export interface SiteState {
  label: string;
  /** One line under the label (the Reviewer's note, what it waits for), or null. */
  detail: string | null;
  tone: SiteTone;
  /** What the tile's link does, and where it goes. */
  cta: string;
  href: string;
}

type Site = Pick<
  ListingSummary,
  "asset" | "next_action" | "verification" | "ipo_at" | "offer"
>;

export function siteState(site: Site, communityId: string): SiteState {
  const { asset } = site;
  const id = asset.id;
  const flow = listingHref(communityId, id);
  const reason = asset.status_reason ?? "";
  switch (asset.status) {
    case "draft":
      return {
        label: "Draft",
        detail: null,
        tone: "draft",
        cta: "Continue",
        href: flow,
      };
    case "rating":
      if (reason === "no_satellite_metrics")
        return {
          label: "Waiting for satellite data",
          detail: null,
          tone: "attention",
          cta: "See why",
          href: flow,
        };
      if (reason.startsWith("rating_failed") || reason === "rating_stale")
        return {
          label: "Rating didn't finish",
          detail: null,
          tone: "attention",
          cta: "Try again",
          href: flow,
        };
      return {
        label: "Being rated",
        detail: null,
        tone: "working",
        cta: "Watch",
        href: flow,
      };
    case "needs_evidence":
      return {
        label: "Needs more evidence",
        detail: null,
        tone: "attention",
        cta: "Add evidence",
        href: flow,
      };
    case "ineligible":
      return {
        label: "Not eligible",
        detail: null,
        tone: "attention",
        cta: "See why",
        href: flow,
      };
    case "withdrawn":
      return {
        label: "Withdrawn",
        detail: null,
        tone: "draft",
        cta: "Open",
        href: flow,
      };
    case "suspended":
      return {
        label: "Trading paused",
        detail: null,
        tone: "attention",
        cta: "See it",
        href: assetHref(id),
      };
    case "listed":
      break;
  }
  if (site.ipo_at)
    return {
      label: "On the Marketplace",
      detail: null,
      tone: "live",
      cta: "See it",
      href: assetHref(id),
    };
  switch (site.next_action) {
    case "offer_in_review":
      return {
        label: "Waiting for the Reviewer",
        detail: null,
        tone: "working",
        cta: "See your offer",
        href: ipoHref(id, communityId),
      };
    case "offer_sent_back":
      return {
        label: "Sent back",
        detail: site.offer?.review_note ? `“${site.offer.review_note}”` : null,
        tone: "attention",
        cta: "Change your offer",
        href: ipoHref(id, communityId),
      };
    case "verify":
      return {
        label:
          site.verification.decision === "rejected"
            ? "Documents not approved"
            : "Needs land documents",
        detail: null,
        tone: "attention",
        cta: "Add documents",
        href: verifyHref(id, communityId),
      };
    case "verification_in_review":
    case "awaiting_verification":
      return {
        label: "Documents in review",
        detail: null,
        tone: "working",
        cta: "Open",
        href: verifyHref(id, communityId),
      };
    case "awaiting_ipo":
      return {
        label: "Rated",
        detail: "The owner sends its offer.",
        tone: "ready",
        cta: "Open",
        href: flow,
      };
    default:
      return {
        label: "Rated",
        detail: "Send your offer when you're ready.",
        tone: "ready",
        cta: "Continue",
        href: flow,
      };
  }
}

const ORDER: Record<SiteTone, number> = {
  attention: 0,
  ready: 1,
  draft: 2,
  working: 3,
  live: 4,
};

/**
 * The sites to show, the ones that need the community first, then the newest. Withdrawn ones
 * are gone for good, so they're left out.
 */
export function shownSites<T extends Site & Pick<ListingSummary, "updated_at">>(
  sites: readonly T[],
  communityId: string,
): { site: T; state: SiteState }[] {
  return sites
    .filter((site) => site.asset.status !== "withdrawn")
    .map((site) => ({ site, state: siteState(site, communityId) }))
    .sort(
      (a, b) =>
        ORDER[a.state.tone] - ORDER[b.state.tone] ||
        Date.parse(b.site.updated_at) - Date.parse(a.site.updated_at),
    );
}

/** "3 sites · 1 on the Marketplace", for a community's card. */
export function sitesLine(sites: readonly Site[]): string {
  const shown = sites.filter((s) => s.asset.status !== "withdrawn");
  if (shown.length === 0) return "No land listed yet";
  const live = shown.filter(
    (s) => s.asset.status === "listed" && s.ipo_at,
  ).length;
  const count = `${shown.length} ${shown.length === 1 ? "site" : "sites"}`;
  return live ? `${count} · ${live} on the Marketplace` : count;
}
