import { describe, expect, it } from "vitest";

import type { AlertList, ListingSummary } from "@/lib/api/types";
import { hasUnseenUpdates, homeSignature } from "@/lib/home-updates";

type Listing = Pick<ListingSummary, "next_action"> & {
  asset: { id: string };
  verification: Partial<ListingSummary["verification"]>;
};

const listing = (id: string, overrides: Partial<Listing> = {}) =>
  ({
    asset: { id },
    next_action: "verify",
    verification: { level: "unverified", decision: null, decided_at: null },
    ...overrides,
  }) as unknown as ListingSummary;

const alerts = (...ids: string[]) =>
  ({ alerts: ids.map((id) => ({ id })) }) as unknown as AlertList;

describe("homeSignature", () => {
  const a = listing("a");
  const b = listing("b");

  it("doesn't depend on the listings' order", () => {
    expect(homeSignature({ listings: [a, b] }, null)).toBe(
      homeSignature({ listings: [b, a] }, null),
    );
  });

  it("changes with a listing's next step, a decision or a new alert", () => {
    const base = homeSignature({ listings: [a] }, alerts("1"));
    expect(
      homeSignature(
        { listings: [listing("a", { next_action: "verification_in_review" })] },
        alerts("1"),
      ),
    ).not.toBe(base);
    expect(
      homeSignature(
        {
          listings: [
            listing("a", {
              verification: {
                decision: "rejected",
                decided_at: "2026-10-20T15:00:00Z",
              },
            }),
          ],
        },
        alerts("1"),
      ),
    ).not.toBe(base);
    expect(homeSignature({ listings: [a] }, alerts("2", "1"))).not.toBe(base);
    expect(homeSignature({ listings: [a, b] }, alerts("1"))).not.toBe(base);
  });

  it("ignores what doesn't need the steward's attention (older alerts, prices)", () => {
    const base = homeSignature({ listings: [a] }, alerts("2", "1"));
    expect(homeSignature({ listings: [a] }, alerts("2"))).toBe(base);
    const priced = {
      ...a,
      asset: { ...a.asset, price: "99.0000" },
    } as ListingSummary;
    expect(homeSignature({ listings: [priced] }, alerts("2"))).toBe(base);
  });

  it("is short enough to store", () => {
    const many = Array.from({ length: 50 }, (_, i) => listing(`asset-${i}`));
    expect(homeSignature({ listings: many }, null).length).toBeLessThan(10);
  });
});

describe("hasUnseenUpdates", () => {
  it("needs a remembered signature that differs from the current one", () => {
    expect(hasUnseenUpdates("x", "y")).toBe(true);
    expect(hasUnseenUpdates("x", "x")).toBe(false);
    expect(hasUnseenUpdates("x", null)).toBe(false);
    expect(hasUnseenUpdates(null, "y")).toBe(false);
  });
});
