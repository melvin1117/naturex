import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AssetView } from "@/components/proto/asset-view";
import { TraceSheet } from "@/components/proto/trace-sheet";
import type { AssetDetail } from "@/lib/api/types";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import { NO_OVERLAY_NOTE } from "@/lib/land-cover-overlay";

import { FakeEventSource, json, sequence } from "../lib/helpers";
import recorded from "../trace/fixtures/recorded-mangrove.json";
import asset from "./fixtures/asset.json";
import images from "./fixtures/images.json";
import ledger from "./fixtures/ledger.json";
import verify from "./fixtures/verify.json";
import { renderExchange, stubBrowserApis } from "./render";

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/asset/x",
  useSearchParams: () => nav.search,
}));

const ASSET = asset as unknown as AssetDetail;
// The API's simplified outline (#212), not the full geometry, draws the hero's map.
const OUTLINE = [
  [-99.1048, 19.2811],
  [-99.0892, 19.2891],
  [-99.0957, 19.2945],
  [-99.1048, 19.2811],
];
const ID = ASSET.id;
const PRICES = [
  { ts: "2026-10-19T00:04:24Z", price: "21.4723", reason: "ipo" },
  { ts: "2026-10-19T01:53:00Z", price: "21.5518", reason: "order" },
];

function routes(overrides: Parameters<typeof renderExchange>[1] = {}) {
  return {
    // The change since opening is the API's (deliberately not what the prices imply).
    [`GET /assets/${ID}`]: () =>
      json({ ...ASSET, price: "21.5518", price_change_pct: 2.5 }),
    [`GET /assets/${ID}/reports`]: () => json([ASSET.latest_report]),
    [`GET /assets/${ID}/prices`]: () => json(PRICES),
    "GET /media/demo-sites/wetland_mx/images.json": () => json(images),
    [`GET /ledger/${ID}`]: () => json(ledger),
    [`GET /ledger/${ID}/verify`]: () => json(verify),
    [`GET /assets/${ID}/verification`]: () =>
      json({
        asset_id: ID,
        level: "verified",
        badge: "Documents reviewed by WildWorth (hackathon process)",
        decided_at: "2026-10-19T09:00:00Z",
        reviewer_role: "platform_admin",
        checks: [{ check: "boundary_free", result: "pass" }],
        not_checked: ["Registry records"],
        ledger_seq: 3,
      }),
    ...overrides,
  };
}

beforeAll(stubBrowserApis);
beforeEach(() => {
  FakeEventSource.reset();
  nav.search = new URLSearchParams();
});

describe("AssetView", () => {
  it("shows a loading state", async () => {
    renderExchange(<AssetView id={ID} />, {
      [`GET /assets/${ID}`]: () => new Promise<Response>(() => {}),
    });
    expect(await screen.findByText("Loading the site…")).toBeInTheDocument();
  });

  it("explains an asset that isn't in this world", async () => {
    renderExchange(<AssetView id={ID} />, {
      [`GET /assets/${ID}`]: () =>
        json({ detail: "not_found" }, { status: 404 }),
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Site not found" }),
    ).toBeInTheDocument();
  });

  it("shows other errors with a retry", async () => {
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: sequence(
          () => json({ detail: "boom" }, { status: 500 }),
          () => json(ASSET),
        ),
      }),
    );
    expect(
      await screen.findByText("We couldn't load this site"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Xochimilco Wetland",
      }),
    ).toBeInTheDocument();
  });

  it("renders the report card and overview from the API", async () => {
    renderExchange(<AssetView id={ID} />, routes());
    const hero = await screen.findByRole("region", {
      name: "Xochimilco Wetland",
    });

    expect(within(hero).getByText("Mexico · 207 ha")).toBeInTheDocument();
    expect(within(hero).getByText("$21.55")).toBeInTheDocument();
    expect(
      await within(hero).findByText("+2.5%", { exact: false }),
    ).toBeInTheDocument();
    expect(within(hero).getByText("$2.1M–$2.7M")).toBeInTheDocument();
    expect(
      within(hero).getByRole("img", { name: /Grade A, Strong health/ }),
    ).toBeInTheDocument();
    expect(
      within(hero).getByText("Proof of Life v1 · Q3 2026"),
    ).toBeInTheDocument();

    expect(screen.getByText("8,828 tCO₂")).toBeInTheDocument();
    expect(screen.getByText("Formula health").nextSibling).toHaveTextContent(
      "76.2",
    );
    expect(screen.getByText("Water stability").parentElement).toHaveTextContent(
      "weight 15%",
    );
    expect(screen.getByText("Trees").parentElement).toHaveTextContent("35.7%");
    expect(screen.getByText("Stable")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: /^Monthly NDVI, 60 months from 2021-10/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Mann–Kendall p = 0.10/)).toBeInTheDocument();
    expect(
      await screen.findByText(/Overlay: Dynamic World land-cover mode/),
    ).toBeInTheDocument();

    const sources = screen.getByRole("region", {
      name: "Data behind this page · Q3 2026 report",
    });
    expect(
      within(sources).getByText(/^Dynamic World: This dataset/),
    ).toBeInTheDocument();
    expect(within(sources).getByText(IMAGERY_ATTRIBUTION)).toBeInTheDocument();

    // The real trade panel (T18): anonymous visitors are asked to sign in and come back here.
    expect(
      await screen.findByRole("link", { name: "Sign in to trade" }),
    ).toHaveAttribute("href", "/login?next=%2Fasset%2Fx");
    // Bea is global (the floating button), not a card on the page; the real trace opens (T34).
    // No run, and the recording didn't load: once that's settled, the card says so.
    const trace = screen.getByRole("region", { name: "How the AI rated it" });
    expect(
      await within(trace).findByText(
        "Its trace appears here after its first rating.",
      ),
    ).toBeInTheDocument();
    expect(within(trace).queryByRole("button")).toBeNull();
    expect(within(trace).queryByRole("link", { name: /Open/ })).toBeNull();
  });

  it("leads from the site to its latest run's full Agent Trace", async () => {
    const run = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    renderExchange(
      <>
        <AssetView id={ID} />
        <TraceSheet />
      </>,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({
            ...ASSET,
            latest_report: { ...ASSET.latest_report, run_id: run },
          }),
      }),
    );
    const trace = await screen.findByRole("region", {
      name: "How the AI rated it",
    });
    expect(
      within(trace).getByRole("link", { name: /Open the Agent Trace/ }),
    ).toHaveAttribute("href", `/trace/${run}`);
    expect(
      within(trace).getByRole("link", {
        name: "Every model at work, with live costs",
      }),
    ).toHaveAttribute("href", "/ai");
    fireEvent.click(within(trace).getByRole("button", { name: "Quick look" }));
    expect(
      await screen.findByRole("dialog", { name: "Agent Trace" }),
    ).toBeInTheDocument();
  });

  it("leads a demo site nobody has rated here to its recorded run", async () => {
    renderExchange(
      <AssetView id={ID} />,
      routes({
        "GET /media/demo-sites/wetland_mx/recorded-run.json": () =>
          json({ ...recorded, site_key: "wetland_mx" }),
      }),
    );
    const trace = await screen.findByRole("region", {
      name: "How the AI rated it",
    });
    expect(
      await within(trace).findByRole("link", { name: /Open the recorded run/ }),
    ).toHaveAttribute("href", `/trace/recorded/${ID}`);
    // The drawer has only this world's runs, none here: no quick look at nothing.
    expect(within(trace).queryByRole("button")).toBeNull();
  });

  it("compares a live listing's own views five years apart", async () => {
    const views = {
      version: "abc123-1761200000",
      media_type: "image/webp" as const,
      width: 640,
      height: 400,
      bounds: { south: 19.27, west: -99.11, north: 19.3, east: -99.08 },
      before: { start: "2021-10-01", end: "2022-10-01" },
      after: { start: "2025-10-01", end: "2026-10-01" },
      attributions: ["Contains modified Copernicus Sentinel data 2021-2026."],
    };
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({ ...ASSET, site_key: null, site_views: views }),
      }),
    );
    expect(
      await screen.findByRole("img", { name: "The site five years earlier" }),
    ).toHaveAttribute(
      "src",
      `/api/assets/${ID}/views/before.webp?v=abc123-1761200000`,
    );
    expect(
      screen.getByRole("img", { name: "The site in the latest 12 months" }),
    ).toHaveAttribute(
      "src",
      `/api/assets/${ID}/views/after.webp?v=abc123-1761200000`,
    );
    expect(
      screen.getByRole("slider", { name: /Compare the two views/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Copernicus Sentinel data 2021–2026/),
    ).toBeInTheDocument();
    // The views' own credits are with the page's data sources.
    const sources = screen.getByRole("region", {
      name: /^Data behind this page/,
    });
    expect(
      within(sources).getByText(
        "Contains modified Copernicus Sentinel data 2021-2026.",
      ),
    ).toBeInTheDocument();
  });

  it("has no before/after views for a listing its rating hasn't rendered them for", async () => {
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({ ...ASSET, site_key: null, site_views: null }),
      }),
    );
    await screen.findByRole("region", { name: "Xochimilco Wetland" });
    expect(
      screen.queryByRole("img", { name: "The site five years earlier" }),
    ).toBeNull();
  });

  it("draws the boundary in the hero of a site without a thumbnail", async () => {
    const { container } = renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({ ...ASSET, site_key: null, outline: [OUTLINE] }),
      }),
    );
    const hero = await screen.findByRole("region", {
      name: "Xochimilco Wetland",
    });
    expect(within(hero).getByText(IMAGERY_ATTRIBUTION)).toBeInTheDocument();
    const map = container.querySelector("[data-boundary-map]")!;
    expect(hero.contains(map)).toBe(true);
    expect(map.querySelectorAll("img").length).toBeGreaterThan(0);
  });

  it("shows a live-rated listing's own land-cover overlay and its credits (#231)", async () => {
    const overlay = {
      version: "abc123-1792650000",
      media_type: "image/png",
      width: 1024,
      height: 946,
      bounds: {
        south: 19.2802,
        west: -99.1056,
        north: 19.2945,
        east: -99.0892,
      },
      crs: "EPSG:3857",
      dataset_id: "GOOGLE/DYNAMICWORLD/V1",
      method: "Per-pixel mode of the Dynamic World V1 label",
      date_window: { start: "2025-10-01", end: "2026-10-01" },
      attributions: [
        "Dynamic World: This dataset is produced for the Dynamic World Project by Google.",
        "Contains modified Copernicus Sentinel data 2025-2026.",
      ],
    };
    const { container } = renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({ ...ASSET, site_key: null, land_cover_overlay: overlay }),
      }),
    );
    expect(
      await screen.findByText(
        "Overlay: Dynamic World land-cover mode, 2025-10-01 to 2026-10-01.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Dynamic World overlay" }),
    ).toBeChecked();
    expect(screen.queryByText(NO_OVERLAY_NOTE)).toBeNull();
    const sources = screen.getByRole("region", {
      name: /^Data behind this page/,
    });
    expect(
      within(sources).getByText(
        "Contains modified Copernicus Sentinel data 2025-2026.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        container.querySelector(
          'img[alt="Xochimilco Wetland land-cover overlay"]',
        ),
      ).toHaveAttribute(
        "src",
        `/api/assets/${ID}/overlay.png?v=abc123-1792650000`,
      ),
    );
  });

  it("says why a listing without a live rating has no land-cover overlay (#231)", async () => {
    const { container } = renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({ ...ASSET, site_key: null, land_cover_overlay: null }),
      }),
    );
    expect(await screen.findByText(NO_OVERLAY_NOTE)).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Dynamic World overlay" }),
    ).toBeNull();
    expect(screen.queryByText(/Overlay: Dynamic World/)).toBeNull();
    expect(
      screen.getByRole("region", { name: "Xochimilco Wetland map" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector('img[alt$="land-cover overlay"]'),
    ).toBeNull();
  });

  it("shows the cover photo in the hero of a listing that has one", async () => {
    const cover = "https://cdn.example.org/covers/wetland.jpg";
    const { container } = renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({
            ...ASSET,
            site_key: null,
            cover_image_url: cover,
            outline: [OUTLINE],
          }),
      }),
    );
    const hero = await screen.findByRole("region", {
      name: "Xochimilco Wetland",
    });
    expect(hero.querySelector(`img[src="${cover}"]`)).not.toBeNull();
    expect(container.querySelector("[data-boundary-map]")).toBeNull();
  });

  it("ignores a cover that isn't https and draws the boundary instead", async () => {
    const { container } = renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({
            ...ASSET,
            site_key: null,
            cover_image_url: "http://cdn.example.org/cover.jpg",
            outline: [OUTLINE],
          }),
      }),
    );
    const hero = await screen.findByRole("region", {
      name: "Xochimilco Wetland",
    });
    expect(hero.querySelector('img[src^="http://"]')).toBeNull();
    expect(container.querySelector("[data-boundary-map]")).not.toBeNull();
  });

  it("keeps the placeholder in the hero of a site without an outline", async () => {
    const { container } = renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({ ...ASSET, site_key: null, outline: [] }),
      }),
    );
    await screen.findByRole("region", { name: "Xochimilco Wetland" });
    expect(container.querySelector("[data-boundary-map]")).toBeNull();
  });

  it("keeps the precomputed thumbnail in the hero of a curated site", async () => {
    const { container } = renderExchange(<AssetView id={ID} />, routes());
    await screen.findByRole("region", { name: "Xochimilco Wetland" });
    expect(container.querySelector("[data-boundary-map]")).toBeNull();
  });

  it("says a value is not available instead of showing zero", async () => {
    const report = {
      ...ASSET.latest_report!,
      value_low: null,
      value_mid: null,
      value_high: null,
      value_breakdown: null,
      rating: {
        ...(ASSET.latest_report!.rating as Record<string, unknown>),
        score: null,
      },
    };
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () => json({ ...ASSET, latest_report: report }),
        [`GET /assets/${ID}/reports`]: () => json([report]),
      }),
    );
    const hero = await screen.findByRole("region", {
      name: "Xochimilco Wetland",
    });
    expect(within(hero).getByText("Not available")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The service breakdown isn't available for this report.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Mid estimate").nextSibling).toHaveTextContent("—");
    expect(
      screen.getByText("Auditor adjustment (±10 max)").nextSibling,
    ).toHaveTextContent("—");
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("labels a listed site awaiting its opening offer and shows no price", async () => {
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({
            ...ASSET,
            trading: false,
            ipo_at: null,
            price: null,
            price_change_pct: null,
            total_shares: null,
            retained_pct: null,
            primary_shares_remaining: 0,
          }),
        [`GET /assets/${ID}/prices`]: () => json([]),
      }),
    );
    const hero = await screen.findByRole("region", {
      name: "Xochimilco Wetland",
    });
    expect(within(hero).getByText("Not trading yet")).toBeInTheDocument();
  });

  it("shows report versions with the summary as text and its source", async () => {
    nav.search = new URLSearchParams("tab=report");
    const v1 = ASSET.latest_report!;
    const v2 = {
      ...v1,
      id: "55555555-5555-4555-8555-555555555555",
      // v2 was never stored (e.g. a failed run): "previous" is the next-older report.
      version: 3,
      health_score: "87.10",
      grade: "AA",
      summary_md: "**Better.** <b>not html</b> [score:base_health]",
      summary_source: "auditor",
      auditor: {
        auditor_adjustment: 2,
        adjustment_reason: "Field photos show replanting.",
        agreement: 0.8,
        greenwashing_risk: "low",
        summary_md: "x",
        citations: ["score:base_health"],
      },
    };
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () => json({ ...ASSET, latest_report: v2 }),
        [`GET /assets/${ID}/reports`]: () => json([v2, v1]),
        [`GET /reports/${v2.id}/diff/${v1.id}`]: () =>
          json({
            report_id: v2.id,
            prev_report_id: v1.id,
            changes: [],
            from_version: 1,
            to_version: 3,
            grade_change: { old: "A", new: "AA", direction: "up" },
            metrics: [],
            reasons: [
              {
                source: "auditor",
                version: 3,
                code: "key_change",
                text: "Replanting raised vegetation vigour [score:vegetation_vigor].",
                citations: ["score:vegetation_vigor"],
              },
            ],
          }),
      }),
    );

    expect(
      await screen.findByRole("heading", { name: /^Proof of Life/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Why it changed")).toBeInTheDocument();
    const reason = screen.getByText(/Replanting raised vegetation vigour/);
    expect(reason.closest("li")).toHaveTextContent(/^Reason 1\s*Auditor/);
    // The citation becomes a tag, as in the report summary.
    expect(
      within(reason.closest("li")!).getByText("score:vegetation_vigor").tagName,
    ).toBe("SPAN");
    expect(screen.getByText("Better.").tagName).toBe("STRONG");
    expect(screen.getByText(/<b>not html<\/b>/)).toBeInTheDocument();
    expect(
      screen.getByText("Written by the Auditor (Nemotron), with cited facts"),
    ).toBeInTheDocument();
    expect(screen.getByText("What changed since v1")).toBeInTheDocument();
    expect(screen.getByText("Was A in Proof of Life v1")).toBeInTheDocument();
    // The table comes from the diff API (#189), not from comparing reports in the browser.
    expect(screen.getByText("Grade").closest("tr")).toHaveTextContent(
      "GradeAAAUpgraded",
    );
    expect(screen.queryByText("Fair price per unit")).toBeNull();
  });

  it("shows a very small p-value as p < 0.01", async () => {
    const report = structuredClone(ASSET.latest_report!) as unknown as {
      rating: {
        metrics: { ndvi_trend_details: { mann_kendall_p_value: number } };
      };
    };
    report.rating.metrics.ndvi_trend_details.mann_kendall_p_value = 0.003;
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () => json({ ...ASSET, latest_report: report }),
      }),
    );
    expect(
      await screen.findByText(/Mann–Kendall p < 0.01/),
    ).toBeInTheDocument();
  });

  it("charts the price history with a text summary", async () => {
    nav.search = new URLSearchParams("tab=price");
    renderExchange(<AssetView id={ID} />, routes());
    expect(
      await screen.findByRole("img", {
        name: "Stake price, 2 recorded prices: $21.47 on 19 Oct to $21.55 on 19 Oct.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/35%/)).toBeNull();
  });

  it("marks re-rates and stored events on the price chart, with a list", async () => {
    nav.search = new URLSearchParams("tab=price");
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}/prices`]: () =>
          json([
            ...PRICES,
            { ts: "2026-10-19T03:00:00Z", price: "18.2000", reason: "rerate" },
          ]),
        [`GET /assets/${ID}`]: () =>
          json({
            ...ASSET,
            recent_events: [
              {
                id: "e1",
                asset_id: ID,
                source: "admin",
                title: "Encroachment at Xochimilco (simulated)",
                direction: -1,
                severity: 4,
                impact_type: "encroachment",
                // The simulated event's day; it was recorded after the re-rate's price.
                published_at: "2026-10-19",
                created_at: "2026-10-19T03:00:01Z",
              },
            ],
          }),
      }),
    );
    const chart = await screen.findByRole("img", {
      name: /^Stake price, 3 recorded prices/,
    });
    const list = screen.getByRole("list", { name: "Marked on the chart" });
    expect(chart).toHaveAttribute("aria-describedby", list.id);
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "11. Opening price · 19 Oct 00:04 UTC · $21.47",
      "22. Re-rated: price moved toward the new fair price · 19 Oct 03:00 UTC · $18.20",
      "33. Encroachment at Xochimilco (simulated) (negative) · 19 Oct 03:00 UTC · $18.20",
    ]);
  });

  it("lists recent events as plain text with a safe source link", async () => {
    nav.search = new URLSearchParams("tab=news");
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}`]: () =>
          json({
            ...ASSET,
            recent_events: [
              {
                id: "e1",
                asset_id: ID,
                source: "tavily",
                title: "Canal <i>cleanup</i> starts",
                url: "javascript:alert(1)",
                direction: 1,
                severity: 2,
                impact_type: "restoration",
                created_at: "2026-10-18T00:00:00Z",
              },
              {
                id: "e2",
                asset_id: ID,
                source: "tavily",
                title: "Fill on the northern edge",
                url: "https://example.org/fill",
                direction: -1,
                severity: 4,
                created_at: "2026-10-17T00:00:00Z",
              },
            ],
          }),
      }),
    );

    expect(
      await screen.findByText("Canal <i>cleanup</i> starts"),
    ).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: /Source/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.org/fill");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.queryByText("Sample")).toBeNull();
  });

  it("shows the verification badge in the hero and the public panel", async () => {
    renderExchange(<AssetView id={ID} />, routes());

    const hero = await screen.findByRole("link", {
      name: /^Documents reviewed by WildWorth \(hackathon process\)/,
    });
    expect(hero).toHaveAttribute("href", "#verification");
    const panel = screen.getByRole("region", {
      name: "How this listing was verified",
    });
    expect(
      within(panel).getByText("WildWorth platform admin"),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Registry records")).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: /entry #3/ }),
    ).toHaveAttribute("href", `/asset/${ID}?tab=ledger#ledger-entry-3`);
  });

  it("scrolls to and outlines the ledger entry a link names", async () => {
    nav.search = new URLSearchParams("tab=ledger");
    window.history.replaceState(
      null,
      "",
      `/asset/${ID}?tab=ledger#ledger-entry-0`,
    );
    renderExchange(<AssetView id={ID} />, routes());

    const entry = (await screen.findByText("#0")).closest("li")!;
    await waitFor(() => expect(entry).toHaveFocus());
    expect(entry).toHaveAttribute("id", "ledger-entry-0");
    window.history.replaceState(null, "", "/");
  });

  it("follows the panel's ledger link while the ledger is already open", async () => {
    nav.search = new URLSearchParams("tab=ledger");
    window.history.replaceState(null, "", `/asset/${ID}?tab=ledger`);
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /assets/${ID}/verification`]: () =>
          json({
            asset_id: ID,
            level: "verified",
            badge: "Documents reviewed by WildWorth (hackathon process)",
            checks: [],
            not_checked: [],
            ledger_seq: 0,
          }),
      }),
    );
    const entry = (await screen.findByText("#0")).closest("li")!;
    expect(entry).not.toHaveFocus();

    fireEvent.click(await screen.findByRole("link", { name: /entry #0/ }));
    await waitFor(() => expect(entry).toHaveFocus());
    expect(window.location.hash).toBe("#ledger-entry-0");
    window.history.replaceState(null, "", "/");
  });

  it("loads the ledger in its own panel's shape, not a spinner (#219)", async () => {
    nav.search = new URLSearchParams("tab=ledger");
    let release: () => void = () => {};
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /ledger/${ID}`]: () =>
          new Promise((resolve) => {
            release = () => resolve(json(ledger));
          }),
      }),
    );

    const region = await waitFor(() => {
      const found = document.querySelector('[data-skeleton="machine-rows"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(screen.getByRole("heading", { name: "The Record" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Verify the Record" }),
    ).toBeDisabled();
    expect(region.querySelector(".animate-spin")).toBeNull();
    act(() => release());
    expect(await screen.findByText("#0")).toBeInTheDocument();
    expect(document.querySelector('[data-skeleton="machine-rows"]')).toBeNull();
  });

  it("loads the price history as a chart-shaped skeleton (#219)", async () => {
    nav.search = new URLSearchParams("tab=price");
    renderExchange(
      <AssetView id={ID} />,
      routes({ [`GET /assets/${ID}/prices`]: () => new Promise(() => {}) }),
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-skeleton="price-chart"]'),
      ).not.toBeNull(),
    );
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("loads the ledger and verifies it on the server", async () => {
    nav.search = new URLSearchParams("tab=ledger");
    const { backend } = renderExchange(<AssetView id={ID} />, routes());

    expect(await screen.findByText("#0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify the Record" }));

    expect(
      await screen.findByText("Chain intact: its 1 entry verified."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(backend.calls(`GET /ledger/${ID}/verify`)).toBe(1),
    );
  });

  it("drops a verify result once the chain changes", async () => {
    nav.search = new URLSearchParams("tab=ledger");
    const next = { ...ledger[0]!, seq: 1, hash: "f".repeat(64) };
    renderExchange(
      <AssetView id={ID} />,
      routes({
        // Initial read and the refetch after verifying: unchanged. Then a new entry.
        [`GET /ledger/${ID}`]: sequence(
          () => json(ledger),
          () => json(ledger),
          () => json([...ledger, next]),
        ),
      }),
    );
    // The panel's real chrome shows while the entries load; verify once they're here.
    expect(await screen.findByText("#0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify the Record" }));
    expect(
      await screen.findByText("Chain intact: its 1 entry verified."),
    ).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(
      screen.getByText("Chain intact: its 1 entry verified."),
    ).toBeInTheDocument();

    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("rating_progress", 1, {
        asset_id: ID,
        step: "done",
        status: "succeeded",
      });
    });

    expect(await screen.findByText("#1")).toBeInTheDocument();
    expect(screen.queryByText(/Chain intact/)).toBeNull();
  });

  it("reports a broken chain", async () => {
    nav.search = new URLSearchParams("tab=ledger");
    renderExchange(
      <AssetView id={ID} />,
      routes({
        [`GET /ledger/${ID}/verify`]: () =>
          json({ valid: false, entries: 1, head: null, broken_at: 0 }),
      }),
    );
    // The panel's real chrome shows while the entries load; verify once they're here.
    expect(await screen.findByText("#0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify the Record" }));
    expect(
      await screen.findByText("Record broken at entry #0."),
    ).toBeInTheDocument();
  });
});
