import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DemoSiteImages } from "@/components/demo-site-images";
import { LandCoverLegend } from "@/components/land-cover-legend";
import { SiteThumbnail } from "@/components/site-thumbnail";
import { demoSiteMediaUrl, type SiteImages } from "@/lib/demo-site-images";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { GET: get } }));
vi.mock("@/components/land-cover-map", () => ({
  LandCoverMap: (props: {
    overlayUrl: string;
    bounds: unknown;
    label: string;
  }) => (
    <div
      data-testid="map"
      data-url={props.overlayUrl}
      data-bounds={JSON.stringify(props.bounds)}
    >
      {props.label}
    </div>
  ),
}));

const LEGEND = [
  { value: 0, key: "water", label: "Water", color: "#419bdf" },
  { value: 1, key: "trees", label: "Trees", color: "#397d49" },
] as SiteImages["overlay"]["legend"];

function sidecar(siteKey: string): SiteImages {
  const window = { start: "2025-10-01", end: "2026-10-01" };
  return {
    site_key: siteKey,
    data_version: "2026Q3",
    scenario: "baseline",
    scenario_note: "Images show the observed baseline only.",
    overlay: {
      file: `${siteKey}.overlay.png`,
      media_type: "image/png",
      width: 1024,
      height: 946,
      bounds: [
        [19.2802, -99.1056],
        [19.2945, -99.0892],
      ],
      crs: "EPSG:3857",
      dataset_id: "GOOGLE/DYNAMICWORLD/V1",
      band: "label",
      method: "mode",
      date_window: window,
      palette: ["#419bdf", "#397d49"],
      legend: LEGEND,
      attributions: ["Dynamic World: produced for the Dynamic World Project."],
    },
    thumbnail: {
      file: `${siteKey}.thumbnail.webp`,
      media_type: "image/webp",
      width: 640,
      height: 400,
      bounds: [
        [19.27, -99.11],
        [19.3, -99.08],
      ],
      crs: "EPSG:3857",
      dataset_ids: ["COPERNICUS/S2_SR_HARMONIZED"],
      method: "median",
      date_window: window,
      visualization: {
        bands: ["B4", "B3", "B2"],
        min: 0,
        max: 2500,
        gamma: 1.1,
      },
      outline_color: "#ffffff",
      attributions: ["Contains modified Copernicus Sentinel data 2025-2026."],
    },
  };
}

describe("demoSiteMediaUrl", () => {
  it("goes through the /api proxy and encodes the key", () => {
    expect(demoSiteMediaUrl("wetland_mx", "overlay.png")).toBe(
      "/api/media/demo-sites/wetland_mx/overlay.png",
    );
    expect(demoSiteMediaUrl("../x", "images.json")).toBe(
      "/api/media/demo-sites/..%2Fx/images.json",
    );
  });
});

describe("SiteThumbnail", () => {
  it("shows the image with its date window and attribution caption", () => {
    render(
      <SiteThumbnail
        src="/api/media/demo-sites/wetland_mx/thumbnail.webp"
        alt="Satellite view"
        width={640}
        height={400}
        dateWindow={{ start: "2025-10-01", end: "2026-10-01" }}
        attributions={["Contains modified Copernicus Sentinel data 2025-2026."]}
      />,
    );

    const img = screen.getByRole("img", { name: "Satellite view" });
    expect(img).toHaveAttribute(
      "src",
      "/api/media/demo-sites/wetland_mx/thumbnail.webp",
    );
    expect(img).toHaveAttribute("width", "640");
    expect(screen.getByText(/2025-10-01 to\s+2026-10-01/)).toBeInTheDocument();
    expect(screen.getByText(/Copernicus Sentinel/)).toBeInTheDocument();
  });
});

describe("LandCoverLegend", () => {
  it("lists each class with its swatch colour", () => {
    render(<LandCoverLegend entries={LEGEND} />);

    const items = within(
      screen.getByRole("list", { name: "Land-cover legend" }),
    ).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Water", "Trees"]);
    expect(items[0].querySelector("span")).toHaveStyle({
      background: "#419bdf",
    });
  });
});

describe("DemoSiteImages", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("loads the sidecar and renders the overlay map and thumbnail", async () => {
    get.mockImplementation(
      async (
        _path: string,
        init: { params: { path: { site_key: string } } },
      ) => ({
        data: sidecar(init.params.path.site_key),
      }),
    );
    render(<DemoSiteImages />);

    const map = await screen.findByTestId("map");
    expect(map).toHaveAttribute(
      "data-url",
      "/api/media/demo-sites/wetland_mx/overlay.png",
    );
    expect(JSON.parse(map.dataset.bounds ?? "")).toEqual([
      [19.2802, -99.1056],
      [19.2945, -99.0892],
    ]);
    expect(
      screen.getByRole("img", { name: /Xochimilco Wetland/ }),
    ).toHaveAttribute("src", "/api/media/demo-sites/wetland_mx/thumbnail.webp");
    expect(screen.getByText(/Dynamic World Project/)).toBeInTheDocument();
    expect(screen.getByText(/baseline only/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Ria Celestun Mangrove" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("map")).toHaveAttribute(
        "data-url",
        "/api/media/demo-sites/mangrove_mx/overlay.png",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Ria Celestun Mangrove" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an error when the sidecar can't be loaded", async () => {
    get.mockResolvedValue({ data: undefined });
    render(<DemoSiteImages />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Couldn.t load the images/,
    );
  });
});
