import { describe, expect, it } from "vitest";

import {
  curatedSite,
  MODEL_CALLS_EMPTY,
  QUARTER_NO_SITES,
} from "@/lib/empty-states";
import { skeletonKind } from "@/lib/route-skeleton";

describe("other empty states", () => {
  it("teach what appears, why it's empty and what makes it appear", () => {
    expect(MODEL_CALLS_EMPTY.body).toMatch(
      /^Live ratings log their model calls/,
    );
    // Fallback runs may log none, so it never promises every live rating logs calls.
    expect(MODEL_CALLS_EMPTY.body).toMatch(/may not either/);
    expect(MODEL_CALLS_EMPTY.body).not.toMatch(/Nemotron/);
    expect(QUARTER_NO_SITES).toMatch(/Once a community lists land/);
  });
});

describe("curatedSite", () => {
  const card = (over: Record<string, unknown>) => ({
    id: "a",
    name: "Site",
    site_key: "hero",
    grade: "A",
    status: "listed",
    ...over,
  });

  it("picks a rated curated site, listed first", () => {
    expect(
      curatedSite([
        card({ id: "user", site_key: null }),
        card({ id: "draft", status: "draft" }),
        card({ id: "hero" }),
      ])?.id,
    ).toBe("hero");
    expect(curatedSite([card({ id: "draft", status: "draft" })])?.id).toBe(
      "draft",
    );
  });

  it("is null without one", () => {
    expect(curatedSite(undefined)).toBeNull();
    expect(curatedSite([card({ site_key: null })])).toBeNull();
    expect(curatedSite([card({ grade: null })])).toBeNull();
  });
});

describe("skeletonKind", () => {
  it.each([
    ["/asset/35df5b9e-90ff-4205-a82e-9ca6e0e06729", "asset"],
    ["/portfolio", "portfolio"],
    ["/portfolio/", "portfolio"],
    ["/steward", "steward-home"],
    ["/steward/assets/abc/verify", "screen"],
    ["/steward/assets/abc/verify", "screen"],
    ["/steward/assets/abc/evidence", "screen"],
    ["/steward/list", "page"],
    ["/steward/community", "community-settings"],
    ["/admin", "time-machine"],
    ["/admin/verifications", "queue"],
    ["/admin/verifications/abc", "review"],
    ["/", "marketplace"],
  ])("%s → %s", (path, kind) => {
    expect(skeletonKind(path)).toBe(kind);
  });
});
