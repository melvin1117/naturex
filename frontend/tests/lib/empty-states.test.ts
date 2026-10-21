import { describe, expect, it } from "vitest";

import {
  MODEL_CALLS_EMPTY,
  payoutsEmptyText,
  QUARTER_NO_SITES,
  recommendationsEmptyText,
} from "@/lib/empty-states";
import { skeletonKind } from "@/lib/route-skeleton";

function listing({
  rated = true,
  mock = false,
  launched = false,
}: { rated?: boolean; mock?: boolean; launched?: boolean } = {}) {
  return {
    report_version: rated ? 1 : null,
    ipo_at: launched ? "2026-10-10T00:00:00Z" : null,
    asset: { mock },
  };
}

describe("recommendationsEmptyText", () => {
  it("says recommendations follow the first rating when nothing is rated", () => {
    expect(recommendationsEmptyText([listing({ rated: false })])).toMatch(
      /^Stewardship actions appear after a site's first rating/,
    );
  });

  it("never tells a rated site's steward to wait for a rating (#216)", () => {
    for (const listings of [
      [listing({ mock: true })],
      [listing({ mock: false })],
      [listing({ rated: false }), listing({ mock: true })],
    ]) {
      expect(recommendationsEmptyText(listings)).not.toMatch(
        /once a site has been rated|after a site's first rating/,
      );
    }
  });

  it("explains that mock ratings carry no recommendations", () => {
    expect(
      recommendationsEmptyText([
        listing({ mock: true }),
        listing({ rated: false }),
      ]),
    ).toBe(
      "Mock ratings don't include the Auditor's recommendations. A live rating lists concrete steps here that would strengthen the grade.",
    );
  });

  it("says a live rating suggested nothing, and when it's reviewed again", () => {
    expect(
      recommendationsEmptyText([
        listing({ mock: true }),
        listing({ mock: false }),
      ]),
    ).toMatch(/^The Auditor's latest report suggests no stewardship actions/);
  });
});

describe("payoutsEmptyText", () => {
  it("names the opening offer as the trigger before one has happened", () => {
    expect(payoutsEmptyText([listing()])).toMatch(
      /^Payouts start after a site's opening offer/,
    );
  });

  it("names the next quarter once a site is open to supporters", () => {
    expect(payoutsEmptyText([listing(), listing({ launched: true })])).toMatch(
      /^The first payout comes when the next quarter runs/,
    );
  });
});

describe("other empty states", () => {
  it("teach what appears, why it's empty and what makes it appear", () => {
    expect(MODEL_CALLS_EMPTY.body).toMatch(/Each live rating logs/);
    expect(MODEL_CALLS_EMPTY.body).toMatch(/mock mode/);
    expect(QUARTER_NO_SITES).toMatch(/Once a community lists land/);
  });
});

describe("skeletonKind", () => {
  it.each([
    ["/asset/35df5b9e-90ff-4205-a82e-9ca6e0e06729", "asset"],
    ["/portfolio", "portfolio"],
    ["/portfolio/", "portfolio"],
    ["/steward", "steward-home"],
    ["/steward/assets/abc/ipo", "screen"],
    ["/steward/assets/abc/verify", "screen"],
    ["/steward/assets/abc/evidence", "screen"],
    ["/steward/list", "page"],
    ["/steward/community", "page"],
    ["/admin", "time-machine"],
    ["/admin/verifications", "admin-list"],
    ["/admin/verifications/abc", "review"],
    ["/", "page"],
  ])("%s → %s", (path, kind) => {
    expect(skeletonKind(path)).toBe(kind);
  });
});
