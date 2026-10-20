import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DrawMap, MAX_CORNER_MARKERS } from "@/components/proto/draw-map";
import type { LatLng } from "@/lib/prototype/data";

// Leaflet doesn't run in jsdom: a fake records what DrawMap asks it to draw.
const leaflet = vi.hoisted(() => {
  const drawn = {
    tooltips: [] as unknown[],
    markers: 0,
    polygons: 0,
  };
  const layer = () => ({
    addTo() {
      return this;
    },
    clearLayers() {},
  });
  return {
    drawn,
    module: {
      map: (container: HTMLElement) => ({
        setView() {
          return this;
        },
        on() {},
        getContainer: () => container,
        remove() {},
        fitBounds() {},
      }),
      tileLayer: layer,
      layerGroup: layer,
      latLngBounds: (points: unknown) => points,
      polygon: () => {
        drawn.polygons += 1;
        return {
          bindTooltip(content: unknown) {
            drawn.tooltips.push(content);
            return this;
          },
          addTo() {
            return this;
          },
        };
      },
      polyline: layer,
      circleMarker: () => {
        drawn.markers += 1;
        return layer();
      },
    },
  };
});
vi.mock("leaflet", () => leaflet.module);

beforeEach(() => {
  leaflet.drawn.tooltips = [];
  leaflet.drawn.markers = 0;
  leaflet.drawn.polygons = 0;
});

const SQUARE: LatLng[] = [
  [0, 0],
  [0, 0.01],
  [0.01, 0.01],
  [0.01, 0],
];

function corners(n: number): LatLng[] {
  return Array.from({ length: n }, (_, i): LatLng => [
    Math.sin((i / n) * 2 * Math.PI) / 100,
    Math.cos((i / n) * 2 * Math.PI) / 100,
  ]);
}

describe("DrawMap", () => {
  it("renders a site's name in its tooltip as text, never as HTML", async () => {
    const name = '<img src="x" onerror="alert(1)">';
    render(
      <DrawMap
        points={[]}
        onAdd={() => {}}
        center={[0, 0]}
        others={[{ name, polygon: SQUARE }]}
        valid
      />,
    );
    await waitFor(() => expect(leaflet.drawn.tooltips).toHaveLength(1));
    const tooltip = leaflet.drawn.tooltips[0];
    expect(tooltip).toBeInstanceOf(HTMLElement);
    expect((tooltip as HTMLElement).textContent).toBe(`${name} (listed)`);
    document.body.appendChild(tooltip as HTMLElement);
    expect(document.querySelector("img")).toBeNull();
  });

  it("draws corner markers only up to MAX_CORNER_MARKERS corners", async () => {
    const { rerender } = render(
      <DrawMap
        points={corners(MAX_CORNER_MARKERS)}
        onAdd={() => {}}
        center={[0, 0]}
        others={[]}
        valid
      />,
    );
    await waitFor(() => expect(leaflet.drawn.markers).toBe(MAX_CORNER_MARKERS));
    leaflet.drawn.markers = 0;
    rerender(
      <DrawMap
        points={corners(MAX_CORNER_MARKERS + 1)}
        onAdd={() => {}}
        center={[0, 0]}
        others={[]}
        valid
      />,
    );
    await waitFor(() => expect(leaflet.drawn.polygons).toBeGreaterThan(1));
    expect(leaflet.drawn.markers).toBe(0);
  });
});
