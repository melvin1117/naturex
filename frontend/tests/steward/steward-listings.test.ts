import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import type { ListingSummary } from "@/lib/api/types";
import {
  groupListings,
  inProgressText,
  listingGroup,
  listingStatusWords,
  rowActions,
  updatedText,
  withdrawFailure,
} from "@/lib/steward-listings";

const COMMUNITY = "66666666-6666-4666-8666-666666666666";

type Status = ListingSummary["asset"]["status"];

function listing(
  status: Status,
  overrides: Partial<ListingSummary> = {},
  asset: Partial<ListingSummary["asset"]> = {},
): ListingSummary {
  const id = `00000000-0000-4000-8000-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`;
  return {
    asset: {
      id,
      name: `Site ${status}`,
      status,
      trading: false,
      area_ha: "120.00",
      sparkline: [],
      outline: [],
      mock: true,
      ...asset,
    } as ListingSummary["asset"],
    next_action: "none",
    verification: { level: "unverified", in_review: false, required: false },
    ipo_at: null,
    updated_at: "2026-10-20T10:00:00Z",
    manage_actions: [],
    wallet: {
      balance: "0.00",
      ipo_proceeds: "0.00",
      community_fund_payouts: "0.00",
      retained_dividends: "0.00",
      total_received: "0.00",
    },
    holders: { count: 0, shares_held: 0, top: [] },
    shares: null,
    recommendations: [],
    report_version: null,
    ...overrides,
  };
}

describe("listingGroup", () => {
  it.each<[Status, string | null, string]>([
    ["draft", null, "in_progress"],
    ["rating", null, "in_progress"],
    ["needs_evidence", null, "in_progress"],
    // Listed but not open yet: waiting for verification or its opening offer.
    ["listed", null, "in_progress"],
    ["listed", "2026-10-10T00:00:00Z", "live"],
    ["suspended", "2026-10-10T00:00:00Z", "live"],
    ["withdrawn", null, "closed"],
    ["ineligible", null, "closed"],
  ])("%s (opened %s) is %s", (status, ipoAt, group) => {
    expect(listingGroup(listing(status, { ipo_at: ipoAt }))).toBe(group);
  });
});

describe("listingStatusWords", () => {
  it.each<[string, ListingSummary, string]>([
    ["a draft", listing("draft"), "Draft: not submitted yet"],
    ["a rating", listing("rating"), "Being rated"],
    [
      "a failed rating",
      listing("rating", {}, { status_reason: "rating_failed:timeout" }),
      "Rating didn't finish",
    ],
    [
      "a rating waiting for data",
      listing("rating", {}, { status_reason: "no_satellite_metrics" }),
      "Waiting for satellite data",
    ],
    ["needs evidence", listing("needs_evidence"), "Needs more evidence"],
    [
      "listed, verify",
      listing("listed", { next_action: "verify" }),
      "Waiting for verification",
    ],
    [
      "listed, documents rejected",
      listing("listed", {
        next_action: "verify",
        verification: {
          level: "rejected",
          in_review: false,
          required: true,
          decision: "rejected",
        },
      }),
      "Documents not approved",
    ],
    [
      "listed, in review",
      listing("listed", { next_action: "verification_in_review" }),
      "Documents in review",
    ],
    [
      "listed, owner may open it",
      listing("listed", { next_action: "launch_ipo" }),
      "Ready for its opening offer",
    ],
    [
      "listed, waiting for the owner",
      listing("listed", { next_action: "awaiting_ipo" }),
      "Ready for its opening offer",
    ],
    [
      "open to supporters",
      listing("listed", {
        ipo_at: "2026-10-10T00:00:00Z",
        next_action: "view_on_exchange",
      }),
      "Live",
    ],
    ["paused", listing("suspended"), "Trading paused"],
    ["withdrawn", listing("withdrawn"), "Withdrawn"],
    ["not eligible", listing("ineligible"), "Not eligible"],
  ])("%s says %s", (_case, item, label) => {
    expect(listingStatusWords(item).label).toBe(label);
  });

  it("never shows market words or codes", () => {
    for (const status of [
      "draft",
      "rating",
      "needs_evidence",
      "listed",
      "suspended",
      "withdrawn",
      "ineligible",
    ] as const) {
      const words = listingStatusWords(listing(status));
      const text = `${words.label} ${words.detail ?? ""}`;
      expect(text).not.toMatch(/IPO|shares|_/);
    }
  });
});

describe("updatedText", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  it.each([
    ["2026-10-21T11:59:30Z", "Updated just now"],
    ["2026-10-21T11:55:00Z", "Updated 5 min ago"],
    ["2026-10-21T09:00:00Z", "Updated 3 h ago"],
    ["2026-10-12T09:00:00Z", "Updated 12 Oct 2026"],
  ])("%s → %s", (iso, text) => {
    expect(updatedText(iso, now)).toBe(text);
  });
});

describe("groupListings", () => {
  it("groups them and puts the most recently changed first", () => {
    const older = listing("draft", { updated_at: "2026-10-01T00:00:00Z" });
    const newer = listing("rating", { updated_at: "2026-10-20T00:00:00Z" });
    const live = listing("listed", { ipo_at: "2026-10-10T00:00:00Z" });
    const closed = listing("withdrawn");
    const groups = groupListings([older, closed, live, newer]);
    expect(groups.in_progress).toEqual([newer, older]);
    expect(groups.live).toEqual([live]);
    expect(groups.closed).toEqual([closed]);
  });
});

describe("inProgressText", () => {
  it.each<[Status[], string | null]>([
    [[], null],
    [["listed"], "1 in progress"],
    [["draft"], "1 draft"],
    [["draft", "draft"], "2 drafts"],
    [["draft", "rating", "needs_evidence"], "1 draft and 2 more in progress"],
    [["withdrawn", "ineligible"], null],
  ])("%j → %s", (statuses, text) => {
    expect(inProgressText(statuses.map((s) => listing(s)))).toBe(text);
  });
});

describe("rowActions", () => {
  it("a draft continues the flow, edits its details and may be withdrawn", () => {
    const draft = listing("draft", {
      next_action: "continue_listing",
      manage_actions: ["edit", "withdraw"],
    });
    const actions = rowActions(draft, COMMUNITY);
    const flow = `/steward/list?community=${COMMUNITY}&asset=${draft.asset.id}`;
    expect(actions.next).toEqual({
      label: "Continue",
      href: flow,
      primary: true,
    });
    expect(actions.edit).toEqual({
      label: "Edit details",
      href: `${flow}&step=details`,
    });
    expect(actions.withdraw).toBe(true);
    expect(actions.view).toBeNull();
  });

  it("offers withdraw only when the API says so", () => {
    const busy = listing("rating", { next_action: "rating_in_progress" });
    expect(rowActions(busy, COMMUNITY)).toMatchObject({
      next: null,
      edit: null,
      withdraw: false,
      view: { label: "View progress" },
    });
    const stuck = listing("rating", {
      next_action: "rating_in_progress",
      manage_actions: ["withdraw"],
    });
    expect(rowActions(stuck, COMMUNITY).withdraw).toBe(true);
  });

  it("someone who isn't a member only views", () => {
    const draft = listing("draft", {
      next_action: "continue_listing",
      manage_actions: ["edit", "withdraw"],
    });
    expect(rowActions(draft, COMMUNITY, { member: false })).toMatchObject({
      next: null,
      edit: null,
      withdraw: false,
      view: { label: "View" },
    });
  });

  it("a closed listing has only View", () => {
    expect(rowActions(listing("withdrawn"), COMMUNITY)).toMatchObject({
      next: null,
      edit: null,
      withdraw: false,
      view: {
        label: "View",
        href: expect.stringContaining("/steward/list?"),
      },
    });
  });

  it("a live site leads to the Exchange", () => {
    const live = listing("listed", {
      ipo_at: "2026-10-10T00:00:00Z",
      next_action: "view_on_exchange",
    });
    expect(rowActions(live, COMMUNITY).next).toMatchObject({
      label: "View on Exchange",
      href: `/asset/${live.asset.id}`,
    });
  });
});

describe("withdrawFailure", () => {
  const err = (status: number, code: string) =>
    new ApiError(status, code, code, code);

  it("a listing that moved on refreshes the list", () => {
    const failure = withdrawFailure(err(409, "cannot_withdraw_listed"));
    expect(failure.message).toMatch(/listed now, so it can't be withdrawn/);
    expect(failure.stale).toBe(true);
  });

  it("a rating that started says to wait", () => {
    const failure = withdrawFailure(err(409, "run_in_progress"));
    expect(failure.title).toBe("A rating is running");
    expect(failure.stale).toBe(true);
  });

  it("anything else is the listing flow's message", () => {
    const failure = withdrawFailure(err(403, "members_only"));
    expect(failure.message).toMatch(/owner and stewards/);
    expect(failure.stale).toBe(false);
  });
});
