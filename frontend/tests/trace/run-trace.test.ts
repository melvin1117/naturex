import { describe, expect, it } from "vitest";

import { traceAssetFromPath } from "@/lib/run-trace";

import { ASSET_ID } from "./fixtures";

describe("traceAssetFromPath", () => {
  it("finds the real site a page is about", () => {
    expect(traceAssetFromPath(`/asset/${ASSET_ID}`)).toBe(ASSET_ID);
    expect(traceAssetFromPath(`/steward/assets/${ASSET_ID}/evidence`)).toBe(
      ASSET_ID,
    );
  });

  it("finds none elsewhere, or for an id that isn't a UUID", () => {
    expect(traceAssetFromPath("/")).toBeNull();
    expect(traceAssetFromPath("/asset/wetland_mx")).toBeNull();
    expect(traceAssetFromPath(null)).toBeNull();
  });
});
