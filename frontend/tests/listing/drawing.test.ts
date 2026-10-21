import { describe, expect, it } from "vitest";

import {
  boundaryIssues,
  drawingHint,
  editorReducer,
  HISTORY_LIMIT,
  initialEditor,
  midpoint,
  type EditorAction,
  type EditorState,
} from "@/lib/listing";
import type { LatLng } from "@/lib/prototype/data";
import { checkPolygon, crossingEdges, perimeterKm } from "@/lib/prototype/geo";

const SQUARE: LatLng[] = [
  [0, 0],
  [0, 0.01],
  [0.01, 0.01],
  [0.01, 0],
];

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

const add = (point: LatLng): EditorAction => ({ type: "add", point });
const drawn = () => run(initialEditor([]), ...SQUARE.map(add));

describe("the boundary editor", () => {
  it("starts drawing when empty and editing when a boundary is restored", () => {
    expect(initialEditor([]).mode).toBe("drawing");
    expect(initialEditor(SQUARE.slice(0, 2)).mode).toBe("drawing");
    expect(initialEditor(SQUARE).mode).toBe("editing");
  });

  it("adds corners rounded to ~1 m, ignoring a repeat of the last one", () => {
    const state = run(
      initialEditor([]),
      add([19.123456789, -99.987654321]),
      add([19.123456, -99.987654]),
    );
    expect(state.points).toEqual([[19.12346, -99.98765]]);
    expect(state.past).toHaveLength(1);
  });

  it("finishes only with three corners or more", () => {
    const two = run(initialEditor([]), add([0, 0]), add([0, 1]));
    expect(editorReducer(two, { type: "finish" })).toBe(two);
    const square = editorReducer(drawn(), { type: "finish" });
    expect(square.mode).toBe("editing");
    expect(square.points).toEqual(SQUARE);
    expect(editorReducer(square, { type: "finish" })).toBe(square);
  });

  it("moves a corner, and ignores a drag that ends where it started", () => {
    const state = editorReducer(drawn(), {
      type: "move",
      index: 2,
      point: [0.02, 0.02],
    });
    expect(state.points[2]).toEqual([0.02, 0.02]);
    expect(
      editorReducer(state, { type: "move", index: 2, point: [0.02, 0.02] }),
    ).toBe(state);
    expect(
      editorReducer(state, { type: "move", index: 9, point: [1, 1] }),
    ).toBe(state);
  });

  it("inserts a corner on an edge, from its midpoint", () => {
    const square = drawn();
    expect(midpoint(SQUARE, 3)).toEqual([0.005, 0]);
    const state = editorReducer(square, {
      type: "insert",
      index: 1,
      point: midpoint(SQUARE, 0),
    });
    expect(state.points).toEqual([[0, 0], [0, 0.005], ...SQUARE.slice(1)]);
    expect(
      editorReducer(square, { type: "insert", index: 7, point: [1, 1] }),
    ).toBe(square);
  });

  it("deletes a corner, and goes back to drawing below three", () => {
    const square = editorReducer(drawn(), { type: "finish" });
    const triangle = editorReducer(square, { type: "remove", index: 0 });
    expect(triangle.points).toEqual(SQUARE.slice(1));
    expect(triangle.mode).toBe("editing");
    expect(editorReducer(triangle, { type: "remove", index: 0 }).mode).toBe(
      "drawing",
    );
  });

  it("undoes and redoes every step, including finishing and clearing", () => {
    const finished = editorReducer(drawn(), { type: "finish" });
    const cleared = editorReducer(finished, { type: "clear" });
    expect(cleared).toMatchObject({ points: [], mode: "drawing" });

    const undone = editorReducer(cleared, { type: "undo" });
    expect(undone).toMatchObject({ points: SQUARE, mode: "editing" });
    const beforeFinish = editorReducer(undone, { type: "undo" });
    expect(beforeFinish).toMatchObject({ points: SQUARE, mode: "drawing" });
    const oneLess = editorReducer(beforeFinish, { type: "undo" });
    expect(oneLess.points).toEqual(SQUARE.slice(0, 3));

    const redone = run(
      oneLess,
      { type: "redo" },
      { type: "redo" },
      { type: "redo" },
    );
    expect(redone).toMatchObject({ points: [], mode: "drawing" });
    expect(editorReducer(redone, { type: "redo" })).toBe(redone);
  });

  it("forgets redo after a new change and caps the history", () => {
    const undone = editorReducer(drawn(), { type: "undo" });
    const changed = editorReducer(undone, add([0.02, 0.02]));
    expect(changed.future).toEqual([]);

    let state = initialEditor([]);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++)
      state = editorReducer(state, add([i, i]));
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    expect(editorReducer(initialEditor([]), { type: "undo" }).past).toEqual([]);
  });

  it("replaces the corners with a pasted boundary, finished", () => {
    const state = editorReducer(initialEditor([]), {
      type: "replace",
      points: SQUARE,
    });
    expect(state).toMatchObject({ points: SQUARE, mode: "editing" });
    expect(editorReducer(state, { type: "undo" }).points).toEqual([]);
  });

  it("says what to do next", () => {
    expect(drawingHint(initialEditor([]))).toMatch(/first corner/);
    expect(drawingHint(initialEditor([]), { zoomedIn: false })).toMatch(
      /zoom in/,
    );
    expect(
      drawingHint({ points: SQUARE.slice(0, 2), mode: "drawing" }),
    ).toMatch(/Keep clicking/);
    expect(drawingHint({ points: SQUARE, mode: "drawing" })).toMatch(/Finish/);
    expect(drawingHint({ points: SQUARE, mode: "editing" })).toMatch(
      /Drag a corner/,
    );
  });
});

describe("boundary measurements and issues on the map", () => {
  it("measures the closed outline", () => {
    // Four sides of 0.01° at the equator, ~1.113 km each.
    expect(perimeterKm(SQUARE)).toBeCloseTo(4.45, 1);
    expect(perimeterKm(SQUARE.slice(0, 1))).toBe(0);
    expect(perimeterKm(SQUARE.slice(0, 2))).toBeCloseTo(1.11, 1);
  });

  it("finds the edges that cross", () => {
    const bowtie: LatLng[] = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]];
    expect(crossingEdges(bowtie)).toEqual([0, 2]);
    expect(crossingEdges(SQUARE)).toEqual([]);
    expect(boundaryIssues(bowtie).crossing).toEqual([0, 2]);
  });

  it("also finds edges that only touch, like the server's check", () => {
    // A corner on another edge (D sits halfway along A–B).
    const touching: LatLng[] = [
      [0, 0],
      [0, 0.04],
      [0.02, 0.04],
      [0, 0.02],
      [0.02, 0],
    ];
    expect(crossingEdges(touching)).toEqual([0, 2, 3]);
    // Two triangles meeting at one corner, placed twice.
    const pinched: LatLng[] = [
      [0, 0],
      [0, 0.02],
      [0.01, 0.01],
      [0.02, 0.02],
      [0.02, 0],
      [0.01, 0.01],
    ];
    expect(crossingEdges(pinched)).toEqual([1, 2, 4, 5]);
    // A spike: out to S and straight back over the same line.
    const spike: LatLng[] = [
      [0, 0],
      [0, 0.02],
      [0.02, 0.02],
      [0.02, 0],
      [0.03, 0],
    ];
    expect(crossingEdges(spike)).toEqual([2, 3, 4]);
    expect(checkPolygon(touching, [])).toMatchObject({
      ok: false,
      code: "self_intersection",
    });
    // A corner placed twice in a row is just a repeat, not a clash.
    expect(
      crossingEdges([SQUARE[0], SQUARE[1], SQUARE[1], SQUARE[2], SQUARE[3]]),
    ).toEqual([]);
  });

  it("finds the listed sites a boundary overlaps", () => {
    const shifted = SQUARE.map(([lat, lon]): LatLng => [
      lat + 0.005,
      lon + 0.005,
    ]);
    const far = SQUARE.map(([lat, lon]): LatLng => [lat + 1, lon + 1]);
    const issues = boundaryIssues(SQUARE, [
      { name: "Far", polygon: far },
      { name: "Near", polygon: shifted },
    ]);
    expect(issues).toEqual({ crossing: [], overlapping: [1] });
    expect(boundaryIssues(SQUARE.slice(0, 2))).toEqual({
      crossing: [],
      overlapping: [],
    });
  });
});
