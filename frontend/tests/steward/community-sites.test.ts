import { describe, expect, it } from "vitest";

import type { ListingSummary } from "@/lib/api/types";
import { shownSites, siteState, sitesLine } from "@/lib/community-sites";

const C = "66666666-6666-4666-8666-666666666666";
const A = "33333333-3333-4333-8333-333333333333";

type Site = Parameters<typeof siteState>[0] &
  Pick<ListingSummary, "updated_at">;

function site(
  status: ListingSummary["asset"]["status"],
  overrides: Partial<Site> = {},
  asset: Partial<ListingSummary["asset"]> = {},
): Site {
  return {
    asset: {
      id: A,
      name: "Laguna Verde",
      status,
      area_ha: "12.00",
      ...asset,
    } as ListingSummary["asset"],
    next_action: "none",
    verification: {
      level: "unverified",
      in_review: false,
      required: false,
      decision: null,
      decided_at: null,
      reason: null,
      run_id: null,
    },
    ipo_at: null,
    offer: null,
    updated_at: "2026-10-20T10:00:00Z",
    ...overrides,
  };
}

const flow = `/steward/list?community=${C}&asset=${A}`;

describe("siteState", () => {
  it.each([
    ["draft", {}, {}, "Draft", "Continue", flow],
    ["rating", {}, {}, "Being rated", "Watch", flow],
    [
      "rating",
      {},
      { status_reason: "rating_failed:timeout" },
      "Rating didn't finish",
      "Try again",
      flow,
    ],
    ["needs_evidence", {}, {}, "Needs more evidence", "Add evidence", flow],
    ["ineligible", {}, {}, "Not eligible", "See why", flow],
    ["suspended", {}, {}, "Trading paused", "See it", `/asset/${A}`],
    [
      "listed",
      { ipo_at: "2026-10-21T10:00:00Z" },
      {},
      "On the Marketplace",
      "See it",
      `/asset/${A}`,
    ],
    ["listed", { next_action: "launch_ipo" }, {}, "Rated", "Continue", flow],
    [
      "listed",
      { next_action: "offer_in_review" },
      {},
      "Waiting for the Reviewer",
      "See your offer",
      `${flow}&step=offer`,
    ],
    [
      "listed",
      { next_action: "verify" },
      {},
      "Needs land documents",
      "Add documents",
      `${flow}&step=prove`,
    ],
  ] as const)(
    "%s (%o, %o) → %s",
    (status, overrides, asset, label, cta, href) => {
      const state = siteState(site(status, overrides, asset), C);
      expect([state.label, state.cta, state.href]).toEqual([label, cta, href]);
    },
  );

  it("quotes the Reviewer's note on an offer sent back", () => {
    const state = siteState(
      site("listed", {
        next_action: "offer_sent_back",
        offer: {
          total_shares: 1_000_000,
          retained_pct: "51.00",
          sent_at: null,
          review_note: "Keep more units.",
        },
      }),
      C,
    );
    expect(state).toMatchObject({
      label: "Sent back",
      detail: "“Keep more units.”",
      tone: "attention",
      cta: "Change your offer",
    });
  });
});

describe("shownSites", () => {
  it("puts what needs the community first, then the newest, and drops withdrawn ones", () => {
    const sites = [
      site("listed", { ipo_at: "2026-10-21T10:00:00Z" }, { id: "live" }),
      site("withdrawn", {}, { id: "gone" }),
      site("draft", { updated_at: "2026-10-22T10:00:00Z" }, { id: "new" }),
      site("draft", {}, { id: "old" }),
      site("needs_evidence", {}, { id: "help" }),
    ];
    expect(shownSites(sites, C).map((s) => s.site.asset.id)).toEqual([
      "help",
      "new",
      "old",
      "live",
    ]);
  });
});

describe("sitesLine", () => {
  it("counts the sites and those on the Marketplace", () => {
    expect(sitesLine([])).toBe("No land listed yet");
    expect(sitesLine([site("draft")])).toBe("1 site");
    expect(
      sitesLine([
        site("draft"),
        site("listed", { ipo_at: "2026-10-21T10:00:00Z" }),
        site("withdrawn"),
      ]),
    ).toBe("2 sites · 1 on the Marketplace");
  });
});
