import { describe, expect, it } from "vitest";

import {
  isRecordTab,
  parseSiteDrawer,
  withSiteDrawer,
} from "@/lib/site-drawer";

describe("a site page's drawers in its URL", () => {
  it("reads the drawers `?tab=` names, and nothing else", () => {
    expect(parseSiteDrawer("trace")).toBe("trace");
    expect(parseSiteDrawer("ledger")).toBe("ledger");
    // The page's own parts and anything crafted open no drawer.
    expect(parseSiteDrawer("news")).toBeNull();
    expect(parseSiteDrawer("price")).toBeNull();
    expect(parseSiteDrawer("__proto__")).toBeNull();
    expect(parseSiteDrawer(null)).toBeNull();
  });

  it("tells the Proof of Life drawer's tabs from the Agent Trace", () => {
    expect(isRecordTab("report")).toBe(true);
    expect(isRecordTab("photos")).toBe(true);
    expect(isRecordTab("trace")).toBe(false);
    expect(isRecordTab(null)).toBe(false);
  });

  it("writes the drawer back, keeping the rest of the URL", () => {
    const base = "https://ww.example/sandbox/asset/1";
    expect(withSiteDrawer(`${base}?x=1`, "trace")).toBe(
      "/sandbox/asset/1?x=1&tab=trace",
    );
    // A ledger entry's hash stays with its tab; closing drops both.
    expect(withSiteDrawer(`${base}?tab=ledger#ledger-entry-3`, "ledger")).toBe(
      "/sandbox/asset/1?tab=ledger#ledger-entry-3",
    );
    expect(withSiteDrawer(`${base}?tab=ledger#ledger-entry-3`, null)).toBe(
      "/sandbox/asset/1",
    );
    // A report version belongs to the report tab only.
    expect(withSiteDrawer(`${base}?tab=report&version=2`, "report")).toBe(
      "/sandbox/asset/1?tab=report&version=2",
    );
    expect(withSiteDrawer(`${base}?tab=report&version=2`, "ledger")).toBe(
      "/sandbox/asset/1?tab=ledger",
    );
  });
});
