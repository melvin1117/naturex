import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BoundaryMap, MAX_HANDLES } from "@/components/listing/boundary-map";
import type { DrawMode, EditorAction } from "@/lib/listing";
import type { LatLng } from "@/lib/prototype/data";

// Leaflet doesn't run in jsdom: a fake records layers and lets tests fire their events.
const leaflet = vi.hoisted(() => {
  type Handler = (e?: unknown) => void;
  const emitter = () => {
    const handlers: Record<string, Handler[]> = {};
    return {
      handlers,
      on(type: string, fn: Handler) {
        (handlers[type] ??= []).push(fn);
        return this;
      },
      fire(type: string, e?: unknown) {
        for (const fn of handlers[type] ?? []) fn(e);
      },
    };
  };
  type FakeMarker = ReturnType<typeof marker>;
  type Group = { markers: FakeMarker[]; tooltips: unknown[] };
  const groups: Group[] = [];
  const state = {
    map: null as null | ReturnType<typeof emitter>,
    get markers() {
      return groups.flatMap((g) => g.markers);
    },
    get tooltips() {
      return groups.flatMap((g) => g.tooltips);
    },
    reset() {
      groups.length = 0;
      state.map = null;
    },
  };
  function marker(latlng: LatLng, options: { icon: { className: string } }) {
    const element = document.createElement("div");
    element.className = options.icon.className;
    let at = { lat: latlng[0], lng: latlng[1] };
    const m = {
      ...emitter(),
      options,
      element,
      addTo(group: Group) {
        group.markers.push(m);
        return m;
      },
      getElement: () => element,
      getLatLng: () => at,
      setLatLng(next: { lat: number; lng: number }) {
        at = next;
        return m;
      },
    };
    return m;
  }
  const shape = () => ({
    tooltip: null as unknown,
    addTo(group?: Group) {
      if (this.tooltip && group) group.tooltips.push(this.tooltip);
      return this;
    },
    setLatLngs() {
      return this;
    },
    bindTooltip(content: unknown) {
      this.tooltip = content;
      return this;
    },
    bringToBack() {
      return this;
    },
    remove() {},
  });
  const group = () => {
    const g = {
      markers: [] as FakeMarker[],
      tooltips: [] as unknown[],
      addTo() {
        groups.push(g);
        return g;
      },
      clearLayers() {
        g.markers = [];
        g.tooltips = [];
      },
    };
    return g;
  };
  return {
    state,
    module: {
      map: (container: HTMLElement) => {
        const map = {
          ...emitter(),
          setView() {
            return map;
          },
          getContainer: () => container,
          remove() {},
          invalidateSize() {},
          flyTo() {},
          flyToBounds() {},
          fitBounds() {},
          // 1 px = 0.001° in this fake projection.
          latLngToContainerPoint: (p: { lat: number; lng: number }) => ({
            x: p.lng * 1000,
            y: -p.lat * 1000,
            add([dx, dy]: [number, number]) {
              return { x: this.x + dx, y: this.y + dy };
            },
          }),
          containerPointToLatLng: (p: { x: number; y: number }) => ({
            lat: -p.y / 1000,
            lng: p.x / 1000,
          }),
        };
        state.map = map;
        return map;
      },
      control: { zoom: () => ({ addTo() {} }) },
      tileLayer: shape,
      layerGroup: group,
      latLngBounds: (points: unknown) => points,
      polygon: shape,
      polyline: shape,
      marker,
      divIcon: (options: unknown) => options,
    },
  };
});
vi.mock("leaflet", () => leaflet.module);

const SQUARE: LatLng[] = [
  [0, 0],
  [0, 0.01],
  [0.01, 0.01],
  [0.01, 0],
];
const NO_ISSUES = { crossing: [], overlapping: [] };

function draw(
  points: LatLng[],
  mode: DrawMode,
  extra: Partial<React.ComponentProps<typeof BoundaryMap>> = {},
) {
  const dispatch = vi.fn<(action: EditorAction) => void>();
  const view = render(
    <BoundaryMap
      points={points}
      mode={mode}
      dispatch={dispatch}
      center={[0, 0]}
      zoom={14}
      focus={null}
      others={[]}
      issues={NO_ISSUES}
      valid
      label="Boundary map"
      {...extra}
    />,
  );
  return { dispatch, ...view };
}

const vertices = () =>
  leaflet.state.markers.filter((m) =>
    m.options.icon.className.includes("vertex"),
  );
const midpoints = () =>
  leaflet.state.markers.filter((m) =>
    m.options.icon.className.includes("midpoint"),
  );

beforeEach(() => leaflet.state.reset());

describe("BoundaryMap", () => {
  it("adds a rounded corner per map click while drawing, and none once finished", async () => {
    const { dispatch, rerender } = draw([], "drawing");
    await waitFor(() => expect(leaflet.state.map).not.toBeNull());
    leaflet.state.map!.fire("click", {
      latlng: { lat: 19.123456789, lng: -99.123456789 },
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "add",
      point: [19.12346, -99.12346],
    });

    dispatch.mockClear();
    rerender(
      <BoundaryMap
        points={SQUARE}
        mode="editing"
        dispatch={dispatch}
        center={[0, 0]}
        zoom={14}
        focus={null}
        others={[]}
        issues={NO_ISSUES}
        valid
        label="Boundary map"
      />,
    );
    leaflet.state.map!.fire("click", { latlng: { lat: 1, lng: 1 } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("closes the shape from its first corner, once it has three", async () => {
    const { dispatch } = draw(SQUARE, "drawing");
    await waitFor(() => expect(vertices()).toHaveLength(4));
    expect(vertices()[0].options.icon.className).toContain("closer");
    expect(midpoints()).toHaveLength(0);
    vertices()[1].fire("click");
    expect(dispatch).not.toHaveBeenCalled();
    vertices()[0].fire("click");
    expect(dispatch).toHaveBeenCalledWith({ type: "finish" });
    expect(vertices()[0].element.getAttribute("aria-label")).toMatch(
      /Enter to finish/,
    );
  });

  it("moves a dragged corner and deletes one on right-click", async () => {
    const { dispatch } = draw(SQUARE, "editing");
    await waitFor(() => expect(vertices()).toHaveLength(4));
    const corner = vertices()[2];
    corner.setLatLng({ lat: 0.02, lng: 0.03 });
    corner.fire("dragend");
    expect(dispatch).toHaveBeenCalledWith({
      type: "move",
      index: 2,
      point: [0.02, 0.03],
    });
    const preventDefault = vi.fn();
    vertices()[1].fire("contextmenu", { originalEvent: { preventDefault } });
    expect(preventDefault).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "remove", index: 1 });
  });

  it("inserts a corner from an edge's midpoint, by click or drag", async () => {
    const { dispatch } = draw(SQUARE, "editing");
    await waitFor(() => expect(midpoints()).toHaveLength(4));
    midpoints()[3].fire("click");
    expect(dispatch).toHaveBeenCalledWith({
      type: "insert",
      index: 4,
      point: [0.005, 0],
    });
    const dragged = midpoints()[0];
    dragged.setLatLng({ lat: -0.004, lng: 0.005 });
    dragged.fire("dragend");
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "insert",
      index: 1,
      point: [-0.004, 0.005],
    });
  });

  it("moves, deletes and inserts corners from the keyboard", async () => {
    const { dispatch } = draw(SQUARE, "editing");
    await waitFor(() => expect(vertices()).toHaveLength(4));
    const corner = vertices()[1].element;
    expect(corner.getAttribute("aria-label")).toBe("Corner 2 of 4");
    expect(corner.getAttribute("aria-describedby")).toBeTruthy();

    act(() => {
      corner.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    const move = dispatch.mock.calls[0][0] as Extract<
      EditorAction,
      { type: "move" }
    >;
    expect(move.index).toBe(1);
    expect(move.point[0]).toBeCloseTo(0);
    expect(move.point[1]).toBeCloseTo(0.014);

    const shifted = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      corner.dispatchEvent(shifted);
    });
    expect(shifted.defaultPrevented).toBe(true);
    const up = dispatch.mock.calls[1][0] as Extract<
      EditorAction,
      { type: "move" }
    >;
    expect(up.point[0]).toBeCloseTo(0.02);

    act(() => {
      corner.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "remove", index: 1 });
    act(() => {
      corner.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Insert", bubbles: true }),
      );
    });
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "insert",
      index: 2,
      point: [0.005, 0.01],
    });
  });

  it("draws handles only up to MAX_HANDLES corners", async () => {
    const many = Array.from({ length: MAX_HANDLES + 1 }, (_, i): LatLng => [
      Math.sin((i / (MAX_HANDLES + 1)) * 2 * Math.PI) / 100,
      Math.cos((i / (MAX_HANDLES + 1)) * 2 * Math.PI) / 100,
    ]);
    draw(many, "editing");
    await waitFor(() => expect(leaflet.state.map).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(leaflet.state.markers).toHaveLength(0);
  });

  it("names listed sites as text, and says when the boundary overlaps one", async () => {
    const name = '<img src="x" onerror="alert(1)">';
    draw(SQUARE, "editing", {
      others: [{ name, polygon: SQUARE }],
      issues: { crossing: [], overlapping: [0] },
    });
    await waitFor(() => expect(leaflet.state.tooltips).toHaveLength(1));
    const tooltip = leaflet.state.tooltips[0] as HTMLElement;
    expect(tooltip).toBeInstanceOf(HTMLElement);
    expect(tooltip.textContent).toBe(
      `${name} (listed): your boundary overlaps it`,
    );
  });
});
