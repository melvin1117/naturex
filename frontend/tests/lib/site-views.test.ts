import { describe, expect, it } from "vitest";

import type { AssetDetail } from "@/lib/api/types";
import { beforeAfterViews } from "@/lib/site-views";

const ID = "9ea6faf1-591b-4616-a014-eb49183eb134";
const VIEWS: NonNullable<AssetDetail["site_views"]> = {
  version: "abc123-1761200000",
  media_type: "image/webp",
  width: 640,
  height: 400,
  bounds: { south: 25.1, west: -80.4, north: 25.2, east: -80.3 },
  before: { start: "2021-10-01", end: "2022-10-01" },
  after: { start: "2025-10-01", end: "2026-10-01" },
  attributions: ["Contains modified Copernicus Sentinel data 2021-2026."],
};

describe("beforeAfterViews", () => {
  it("uses a demo site's precomputed pair", () => {
    expect(
      beforeAfterViews({ id: ID, site_key: "wetland_mx", site_views: null }),
    ).toEqual({
      before: "/api/media/demo-sites/wetland_mx/before.webp",
      after: "/api/media/demo-sites/wetland_mx/thumbnail.webp",
      years: "2021–2026",
    });
  });

  it("uses a live listing's views from its rating, versioned for the cache", () => {
    expect(
      beforeAfterViews({ id: ID, site_key: null, site_views: VIEWS }),
    ).toEqual({
      before: `/api/assets/${ID}/views/before.webp?v=abc123-1761200000`,
      after: `/api/assets/${ID}/views/after.webp?v=abc123-1761200000`,
      years: "2021–2026",
    });
  });

  it("has nothing for a listing without views yet", () => {
    expect(
      beforeAfterViews({ id: ID, site_key: null, site_views: null }),
    ).toBeNull();
    expect(beforeAfterViews({ id: ID, site_key: null })).toBeNull();
  });
});
