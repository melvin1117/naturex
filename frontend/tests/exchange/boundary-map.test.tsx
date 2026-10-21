import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BoundaryMap } from "@/components/boundary-map";
import { FeatureSiteCard, SiteCard } from "@/components/proto/site-card";
import type { AssetCard } from "@/lib/api/types";
import type { LonLatRing } from "@/lib/boundary-map";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import { marketCard } from "@/lib/market-cards";

const RING: LonLatRing = [
  [-84.1, 9.9],
  [-84.0886, 9.9],
  [-84.0886, 9.9109],
  [-84.1, 9.9109],
  [-84.1, 9.9],
];

function card(overrides: Partial<AssetCard> = {}) {
  return marketCard({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Bosque Vivo",
    country: "CR",
    status: "listed",
    trading: false,
    area_ha: "144.00",
    cover_image_url: null,
    site_key: null,
    outline: [RING],
    sparkline: [],
    ...overrides,
  } as AssetCard);
}

function tiles(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLImageElement>("[data-boundary-map] img"),
  ];
}

describe("a card without a precomputed thumbnail", () => {
  it("shows the boundary on lazily loaded imagery, with alt text and the credit", () => {
    const { container } = render(<SiteCard card={card()} />);
    const link = screen.getByRole("link", { name: /Bosque Vivo/ });
    expect(
      within(link).getByRole("img", {
        name: "Boundary of Bosque Vivo on satellite imagery",
      }),
    ).toBeInTheDocument();
    expect(within(link).getByText(IMAGERY_ATTRIBUTION)).toBeVisible();
    const imgs = tiles(container);
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs.length).toBeLessThanOrEqual(6);
    for (const img of imgs) {
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img.getAttribute("src")).toMatch(
        /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\//,
      );
    }
    expect(container.querySelector("[data-boundary-map] path")).not.toBeNull();
  });

  it("falls back to the placeholder if a tile fails", () => {
    const { container } = render(<SiteCard card={card()} />);
    fireEvent.error(tiles(container)[0]);
    expect(container.querySelector("[data-boundary-map]")).toBeNull();
    expect(screen.queryByText(IMAGERY_ATTRIBUTION)).not.toBeInTheDocument();
  });

  it("keeps the placeholder without an outline", () => {
    const { container } = render(<SiteCard card={card({ outline: [] })} />);
    expect(container.querySelector("[data-boundary-map]")).toBeNull();
    expect(screen.queryByText(IMAGERY_ATTRIBUTION)).not.toBeInTheDocument();
  });
});

describe("a card with a precomputed thumbnail", () => {
  it("shows the thumbnail, not the map", () => {
    const { container } = render(
      <SiteCard card={card({ site_key: "wetland_mx" })} />,
    );
    expect(
      screen.getByRole("img", { name: "Satellite view of Bosque Vivo" }),
    ).toHaveAttribute(
      "src",
      expect.stringContaining("/demo-sites/wetland_mx/thumbnail.webp"),
    );
    expect(container.querySelector("[data-boundary-map]")).toBeNull();
  });
});

describe("the featured card", () => {
  it("draws the boundary behind the title, decorative, with the credit", () => {
    const { container } = render(<FeatureSiteCard card={card()} />);
    const section = screen.getByRole("region", { name: "Bosque Vivo" });
    expect(within(section).getByText(IMAGERY_ATTRIBUTION)).toBeInTheDocument();
    expect(tiles(container).length).toBeGreaterThan(0);
    expect(within(section).queryByRole("img", { name: /Boundary/ })).toBeNull();
  });
});

describe("BoundaryMap", () => {
  it("renders nothing for an unusable outline", () => {
    const { container } = render(
      <BoundaryMap
        rings={[
          [
            [0, 0],
            [1, 1],
          ],
        ]}
        label="x"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
