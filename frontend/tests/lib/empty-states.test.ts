import { describe, expect, it } from "vitest";

import { QUARTER_NO_SITES } from "@/lib/empty-states";
import { skeletonKind } from "@/lib/route-skeleton";

describe("other empty states", () => {
  it("teach what appears, why it's empty and what makes it appear", () => {
    expect(QUARTER_NO_SITES).toMatch(/Once a community lists land/);
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
