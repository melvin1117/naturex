/**
 * The boundary editor's state (#215): corners, whether the shape is finished, and undo/redo.
 * Pure, so every gesture on the map (add, drag, insert, delete, finish) is tested here and the
 * map only translates clicks and drags into these actions.
 */
import type { LatLng } from "../prototype/data";

/** `drawing`: map clicks add corners. `editing`: the shape is closed; drag corners to adjust. */
export type DrawMode = "drawing" | "editing";

type Snapshot = { points: LatLng[]; mode: DrawMode };

export type EditorState = Snapshot & { past: Snapshot[]; future: Snapshot[] };

export type EditorAction =
  | { type: "add"; point: LatLng }
  | { type: "move"; index: number; point: LatLng }
  /** Insert a corner at `index` (between corners index - 1 and index), e.g. from a midpoint. */
  | { type: "insert"; index: number; point: LatLng }
  | { type: "remove"; index: number }
  | { type: "finish" }
  | { type: "clear" }
  /** Replace every corner, e.g. with a pasted boundary. */
  | { type: "replace"; points: LatLng[] }
  | { type: "undo" }
  | { type: "redo" };

/** Steps kept for undo; older ones are dropped. */
export const HISTORY_LIMIT = 100;
export const MIN_CORNERS = 3;

/** Rounded to 5 decimals (~1 m), like typed coordinates. */
export function roundPoint([lat, lon]: LatLng): LatLng {
  return [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
}

function same(a: LatLng | undefined, b: LatLng): boolean {
  return !!a && a[0] === b[0] && a[1] === b[1];
}

/** A saved or restored boundary opens finished, ready to adjust; an empty one opens drawing. */
export function initialEditor(points: LatLng[]): EditorState {
  return {
    points,
    mode: points.length >= MIN_CORNERS ? "editing" : "drawing",
    past: [],
    future: [],
  };
}

function commit(state: EditorState, next: Snapshot): EditorState {
  // Fewer than three corners can't be a finished shape.
  const mode = next.points.length < MIN_CORNERS ? "drawing" : next.mode;
  const past = [...state.past, { points: state.points, mode: state.mode }];
  return {
    points: next.points,
    mode,
    past: past.slice(-HISTORY_LIMIT),
    future: [],
  };
}

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  const { points } = state;
  switch (action.type) {
    case "add": {
      const point = roundPoint(action.point);
      // A double click (or a repeat of the last typed corner) isn't a new corner.
      if (same(points.at(-1), point)) return state;
      return commit(state, { points: [...points, point], mode: state.mode });
    }
    case "move": {
      if (!(action.index in points)) return state;
      const point = roundPoint(action.point);
      if (same(points[action.index], point)) return state;
      const next = points.slice();
      next[action.index] = point;
      return commit(state, { points: next, mode: state.mode });
    }
    case "insert": {
      if (action.index < 0 || action.index > points.length) return state;
      const next = points.slice();
      next.splice(action.index, 0, roundPoint(action.point));
      return commit(state, { points: next, mode: state.mode });
    }
    case "remove": {
      if (!(action.index in points)) return state;
      return commit(state, {
        points: points.filter((_, i) => i !== action.index),
        mode: state.mode,
      });
    }
    case "finish":
      if (state.mode === "editing" || points.length < MIN_CORNERS) return state;
      return commit(state, { points, mode: "editing" });
    case "clear":
      if (!points.length) return state;
      return commit(state, { points: [], mode: "drawing" });
    case "replace":
      return commit(state, { points: action.points, mode: "editing" });
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...previous,
        past: state.past.slice(0, -1),
        future: [{ points, mode: state.mode }, ...state.future],
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return {
        ...next,
        past: [...state.past, { points, mode: state.mode }],
        future: rest,
      };
    }
  }
}

/** The corner halfway along edge `index` (from corner index to the next, wrapping round). */
export function midpoint(points: LatLng[], index: number): LatLng {
  const a = points[index];
  const b = points[(index + 1) % points.length];
  return roundPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
}

/** Below this zoom the first click zooms in instead: a corner placed from space is a guess. */
export const MIN_DRAW_ZOOM = 10;

/** One sentence on what to do next, for the hint on the map. */
export function drawingHint(
  state: Pick<EditorState, "points" | "mode">,
  { zoomedIn = true }: { zoomedIn?: boolean } = {},
): string {
  const n = state.points.length;
  if (state.mode === "editing")
    return "Drag a corner to adjust it. Drag a small dot between corners to add one.";
  if (n === 0 && !zoomedIn)
    return "Search for your land, or click the map to zoom in.";
  if (n === 0) return "Click the map to place the first corner of your land.";
  if (n < MIN_CORNERS) return "Keep clicking around the edge of your land.";
  return "Click the first corner or Finish to close the shape.";
}
