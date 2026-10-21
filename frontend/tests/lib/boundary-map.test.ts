import { describe, expect, it } from "vitest";

import {
  boundaryView,
  geojsonRings,
  type LonLatRing,
  outlineRings,
} from "@/lib/boundary-map";

// A ~1.2 km square near the Xochimilco demo wetland, [lon, lat].
const SQUARE: LonLatRing = [
  [-99.1, 19.28],
  [-99.0886, 19.28],
  [-99.0886, 19.2909],
  [-99.1, 19.2909],
  [-99.1, 19.28],
];
const SIZE = { width: 384, height: 216 };

function pathBox(path: string) {
  const nums = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

describe("boundaryView", () => {
  it("fits the boundary at the closest zoom that leaves a margin, centred", () => {
    const view = boundaryView([SQUARE], SIZE)!;
    expect(view.zoom).toBe(14);
    const box = pathBox(view.paths[0]);
    expect((box.left + box.right) / 2).toBeCloseTo(SIZE.width / 2, 0);
    expect((box.top + box.bottom) / 2).toBeCloseTo(SIZE.height / 2, 0);
    expect(box.left).toBeGreaterThan(0);
    expect(box.top).toBeGreaterThan(0);
    // One zoom closer would not fit: the outline already spans over a third of the frame.
    expect((box.bottom - box.top) * 2).toBeGreaterThan(SIZE.height * 0.76);
  });

  it("covers the whole frame with tiles, and only those", () => {
    const view = boundaryView([SQUARE], SIZE)!;
    const lefts = view.tiles.map((t) => t.left);
    const tops = view.tiles.map((t) => t.top);
    expect(Math.min(...lefts)).toBeLessThanOrEqual(0);
    expect(Math.min(...tops)).toBeLessThanOrEqual(0);
    expect(Math.max(...lefts) + 256).toBeGreaterThanOrEqual(SIZE.width);
    expect(Math.max(...tops) + 256).toBeGreaterThanOrEqual(SIZE.height);
    expect(Math.max(...lefts)).toBeLessThan(SIZE.width);
    expect(Math.max(...tops)).toBeLessThan(SIZE.height);
    expect(view.tiles.length).toBeLessThanOrEqual(6);
    expect(view.tiles[0].url).toMatch(
      /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/14\/\d+\/\d+$/,
    );
    expect(new Set(view.tiles.map((t) => t.url)).size).toBe(view.tiles.length);
  });

  it("caps the zoom for a tiny boundary and backs out for a large one", () => {
    const dot: LonLatRing = [
      [10, 10],
      [10.00001, 10],
      [10, 10.00001],
    ];
    expect(boundaryView([dot], SIZE)!.zoom).toBe(17);
    const big: LonLatRing = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ];
    expect(boundaryView([big], SIZE)!.zoom).toBeLessThanOrEqual(3);
  });

  it("frames every part of a multi-part boundary", () => {
    const east = SQUARE.map(
      ([lon, lat]) => [lon + 0.1, lat] as [number, number],
    );
    const view = boundaryView([SQUARE, east], SIZE)!;
    expect(view.paths).toHaveLength(2);
    expect(view.zoom).toBeLessThan(14);
  });

  it("wraps tile columns across the antimeridian", () => {
    const view = boundaryView(
      [
        [
          [179.99, 0],
          [179.999, 0],
          [179.999, 0.01],
        ],
      ],
      SIZE,
    )!;
    const columns = view.tiles.map((t) => Number(t.url.split("/").at(-1)));
    const n = 2 ** view.zoom;
    expect(columns.every((x) => x >= 0 && x < n)).toBe(true);
    expect(columns).toContain(0);
  });

  it("keeps a boundary across the antimeridian in one piece, each tile keyed once", () => {
    const view = boundaryView(
      [
        [
          [179.995, -16.5],
          [-179.995, -16.5],
          [-179.995, -16.49],
          [179.995, -16.49],
        ],
      ],
      SIZE,
    )!;
    expect(view.zoom).toBeGreaterThanOrEqual(12);
    const box = pathBox(view.paths[0]);
    expect(box.right - box.left).toBeLessThan(SIZE.width);
    const n = 2 ** view.zoom;
    const columns = view.tiles.map((t) => Number(t.url.split("/").at(-1)));
    expect(columns).toContain(0);
    expect(columns).toContain(n - 1);
    expect(new Set(view.tiles.map((t) => t.key)).size).toBe(view.tiles.length);
  });

  it("keys tiles uniquely even when a column repeats around the world", () => {
    const world: LonLatRing = [
      [-170, -60],
      [170, -60],
      [170, 60],
      [-170, 60],
    ];
    const view = boundaryView([world], { width: 1024, height: 256 })!;
    expect(view.zoom).toBe(0);
    const urls = view.tiles.map((t) => t.url);
    expect(new Set(urls).size).toBeLessThan(urls.length);
    expect(new Set(view.tiles.map((t) => t.key)).size).toBe(view.tiles.length);
  });

  it("has nothing to draw without a usable ring", () => {
    expect(boundaryView([], SIZE)).toBeNull();
    expect(
      boundaryView(
        [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        SIZE,
      ),
    ).toBeNull();
    expect(
      boundaryView(
        [
          [
            [Number.NaN, 0],
            [1, 1],
            [2, 2],
          ],
        ],
        SIZE,
      ),
    ).toBeNull();
  });
});

describe("outlineRings", () => {
  it("reads the API's outline, dropping empty rings", () => {
    expect(outlineRings([SQUARE, []])).toEqual([SQUARE]);
    expect(outlineRings(undefined)).toEqual([]);
  });
});

describe("geojsonRings", () => {
  const ring = SQUARE.map(([lon, lat]) => [lon, lat]);

  it("reads a Polygon, a Feature and every MultiPolygon part, holes dropped", () => {
    const hole = [
      [-99.095, 19.285],
      [-99.094, 19.285],
      [-99.094, 19.286],
    ];
    expect(
      geojsonRings({ type: "Polygon", coordinates: [ring, hole] }),
    ).toEqual([SQUARE]);
    expect(
      geojsonRings({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
      }),
    ).toEqual([SQUARE]);
    expect(
      geojsonRings({ type: "MultiPolygon", coordinates: [[ring], [ring]] }),
    ).toHaveLength(2);
  });

  it("skips positions that aren't pairs of numbers", () => {
    expect(
      geojsonRings({ type: "Polygon", coordinates: [[...ring, ["x", 1], 3]] }),
    ).toEqual([SQUARE]);
  });

  it("is empty for anything else", () => {
    expect(geojsonRings({ type: "Point", coordinates: [0, 0] })).toEqual([]);
    expect(geojsonRings({ type: "Polygon", coordinates: "x" })).toEqual([]);
    expect(geojsonRings(null)).toEqual([]);
  });
});
