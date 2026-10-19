import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AssetView } from "@/components/proto/asset-view";
import type { AssetDetail } from "@/lib/api/types";

import { FakeEventSource, json, sequence } from "../lib/helpers";
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
        json({ detail: "Asset not found" }, { status: 404 }),
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
    expect(within(hero).getByText("Report v1 · Q3 2026")).toBeInTheDocument();

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
    expect(
      within(sources).getByText("Imagery © Esri, Maxar, Earthstar Geographics"),
    ).toBeInTheDocument();

    // Out of scope for now: trading, Copilot and the trace are disabled, not faked.
    expect(screen.getByRole("button", { name: "Buy units" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Copilot" })).toBeDisabled();
    expect(
      screen.getByText(/Trading from this page is coming soon/),
    ).toBeInTheDocument();
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

  it("shows report versions with the summary as text and its source", async () => {
    nav.search = new URLSearchParams("tab=report");
    const v1 = ASSET.latest_report!;
    const v2 = {
      ...v1,
      id: "55555555-5555-4555-8555-555555555555",
      version: 2,
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
      }),
    );

    expect(
      await screen.findByText("Ecological Performance Report · v2"),
    ).toBeInTheDocument();
    expect(screen.getByText("Better.").tagName).toBe("STRONG");
    expect(screen.getByText(/<b>not html<\/b>/)).toBeInTheDocument();
    expect(
      screen.getByText("Written by the Auditor (Nemotron), with cited facts"),
    ).toBeInTheDocument();
    expect(screen.getByText("What changed since v1")).toBeInTheDocument();
    expect(screen.getByText("Was A in report v1")).toBeInTheDocument();
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

  it("loads the ledger and verifies it on the server", async () => {
    nav.search = new URLSearchParams("tab=ledger");
    const { backend } = renderExchange(<AssetView id={ID} />, routes());

    expect(await screen.findByText("#0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));

    expect(
      await screen.findByText("Chain intact: its 1 entry verified."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(backend.calls(`GET /ledger/${ID}/verify`)).toBe(1),
    );
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Verify chain" }),
    );
    expect(
      await screen.findByText("Tampering detected at entry #0."),
    ).toBeInTheDocument();
  });
});
