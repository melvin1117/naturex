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
    zoom: 14,
    flewTo: null as unknown,
    tiles: [] as { url: string; options: Record<string, unknown> }[],
    get markers() {
      return groups.flatMap((g) => g.markers);
    },
    get tooltips() {
      return groups.flatMap((g) => g.tooltips);
    },
    reset() {
      groups.length = 0;
      state.map = null;
      state.zoom = 14;
      state.flewTo = null;
      state.tiles = [];
      document.querySelectorAll(".ww-handle").forEach((el) => el.remove());
    },
  };
  function marker(
    latlng: LatLng,
    options: { icon: { className: string }; keyboard?: boolean },
  ) {
    const element = document.createElement("div");
    element.className = options.icon.className;
    // Like Leaflet, keyboard markers can take focus.
    if (options.keyboard) element.tabIndex = 0;
    document.body.append(element);
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
          getZoom: () => state.zoom,
          flyTo(...args: unknown[]) {
            state.flewTo = args;
          },
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
      tileLayer: (url: string, options: Record<string, unknown>) => {
        state.tiles.push({ url, options });
        return shape();
      },
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

  it("zooms in instead of placing a first corner from far out", async () => {
    leaflet.state.zoom = 3;
    const zoomed = vi.fn();
    const { dispatch } = draw([], "drawing", { onZoomedIn: zoomed });
    await waitFor(() => expect(leaflet.state.map).not.toBeNull());
    expect(zoomed).toHaveBeenLastCalledWith(false);
    leaflet.state.map!.fire("click", { latlng: { lat: 19, lng: -99 } });
    expect(dispatch).not.toHaveBeenCalled();
    expect(leaflet.state.flewTo).toEqual([
      { lat: 19, lng: -99 },
      7,
      { duration: 0.8 },
    ]);
    leaflet.state.zoom = 12;
    leaflet.state.map!.fire("zoomend");
    expect(zoomed).toHaveBeenLastCalledWith(true);
    leaflet.state.map!.fire("click", { latlng: { lat: 19, lng: -99 } });
    expect(dispatch).toHaveBeenCalledWith({ type: "add", point: [19, -99] });
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
  it("keeps the satellite imagery (scaled up) past its last native zoom", async () => {
    const { rerender } = draw([], "drawing");
    await waitFor(() => expect(leaflet.state.tiles.length).toBeGreaterThan(0));
    const [imagery, labels] = leaflet.state.tiles;
    expect(imagery.options).toMatchObject({ maxZoom: 19, maxNativeZoom: 18 });
    expect(labels.options).toMatchObject({ maxZoom: 19, maxNativeZoom: 18 });

    rerender(
      <BoundaryMap
        points={[]}
        mode="drawing"
        dispatch={vi.fn()}
        center={[0, 0]}
        zoom={14}
        focus={null}
        others={[]}
        issues={NO_ISSUES}
        valid
        basemap="map"
        label="Boundary map"
      />,
    );
    await waitFor(() =>
      expect(leaflet.state.tiles.at(-1)!.url).toContain("openstreetmap"),
    );
    expect(leaflet.state.tiles.at(-1)!.options.attribution).toContain(
      'href="https://www.openstreetmap.org/copyright"',
    );
  });

  it("doesn't rebuild the handles when equal issues arrive (a refetch mid-drag)", async () => {
    const issues = { crossing: [0, 2], overlapping: [0] };
    const props = {
      points: SQUARE,
      mode: "editing" as const,
      dispatch: vi.fn(),
      center: [0, 0] as LatLng,
      zoom: 14,
      focus: null,
      others: [{ name: "Selva", polygon: SQUARE }],
      valid: false,
      label: "Boundary map",
    };
    const { rerender } = render(<BoundaryMap {...props} issues={issues} />);
    await waitFor(() => expect(vertices()).toHaveLength(4));
    const dragged = vertices()[1];
    const tooltip = leaflet.state.tooltips[0];
    rerender(
      <BoundaryMap
        {...props}
        others={[{ name: "Selva", polygon: SQUARE }]}
        issues={{ crossing: [0, 2], overlapping: [0] }}
      />,
    );
    expect(vertices()[1]).toBe(dragged);
    rerender(
      <BoundaryMap
        {...props}
        others={[{ name: "Selva", polygon: SQUARE }]}
        issues={{ crossing: [0, 2], overlapping: [] }}
      />,
    );
    expect(vertices()[1]).toBe(dragged);
    expect(leaflet.state.tooltips[0]).not.toBe(tooltip);
    rerender(
      <BoundaryMap {...props} issues={{ crossing: [1, 3], overlapping: [] }} />,
    );
    expect(vertices()[1]).not.toBe(dragged);
  });

  it("refocuses a corner after a keyboard edit only if the edit changed the shape", async () => {
    const dispatch = vi.fn<(action: EditorAction) => boolean>(() => false);
    const props = {
      mode: "editing" as const,
      dispatch,
      center: [0, 0] as LatLng,
      zoom: 14,
      focus: null,
      others: [],
      issues: NO_ISSUES,
      valid: true,
      label: "Boundary map",
    };
    const { rerender } = render(<BoundaryMap {...props} points={SQUARE} />);
    await waitFor(() => expect(vertices()).toHaveLength(4));
    act(() => {
      vertices()[2].element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "remove", index: 2 });
    // Refused (a save was pending): a later, unrelated redraw leaves focus alone.
    (document.activeElement as HTMLElement | null)?.blur();
    rerender(<BoundaryMap {...props} points={SQUARE.slice(0, 3)} />);
    expect(document.activeElement).toBe(document.body);

    dispatch.mockReturnValue(true);
    rerender(<BoundaryMap {...props} points={SQUARE} />);
    act(() => {
      vertices()[2].element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    rerender(<BoundaryMap {...props} points={SQUARE.slice(0, 3)} />);
    expect(document.activeElement).toBe(vertices()[1].element);
  });

  it("selects a corner on tap, drag, focus or long press, and marks it", async () => {
    const onSelect = vi.fn();
    const { dispatch, rerender } = draw(SQUARE, "editing", { onSelect });
    await waitFor(() => expect(vertices()).toHaveLength(4));
    vertices()[2].fire("click");
    expect(onSelect).toHaveBeenLastCalledWith(2);
    vertices()[3].fire("dragstart");
    expect(onSelect).toHaveBeenLastCalledWith(3);
    vertices()[1].element.focus();
    expect(onSelect).toHaveBeenLastCalledWith(1);

    // A long press on a touch screen selects; it never deletes.
    const preventDefault = vi.fn();
    vertices()[0].fire("contextmenu", {
      originalEvent: { preventDefault, pointerType: "touch" },
    });
    expect(onSelect).toHaveBeenLastCalledWith(0);
    vertices()[0].fire("contextmenu", {
      originalEvent: { preventDefault, _simulated: true },
    });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    // Nor does a right-click that lands mid-drag.
    vertices()[3].fire("dragstart");
    vertices()[3].fire("contextmenu", { originalEvent: { preventDefault } });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "remove", index: 3 });

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
        selected={2}
        onSelect={onSelect}
        label="Boundary map"
      />,
    );
    expect(vertices()[2].element.className).toContain("ww-handle--selected");
    expect(vertices()[1].element.className).not.toContain(
      "ww-handle--selected",
    );
  });
});
