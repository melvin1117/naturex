"use client";

import {
  ArrowRight,
  Check,
  ClipboardPaste,
  Crosshair,
  MapPinPlus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";

import type { MapFocus } from "@/components/proto/draw-map";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, MyCommunity } from "@/lib/api/types";
import {
  useAssetOutlines,
  useCreateListing,
  useUpdateListing,
} from "@/lib/hooks";
import {
  boundaryHint,
  boundaryIssues,
  boundaryPoints,
  detailsBody,
  drawingHint,
  editorReducer,
  initialEditor,
  listingFailure,
  outlinePolygons,
  parseBoundary,
  parseCoordinates,
  sameBoundary,
  toPolygonGeoJson,
  type BoundaryHint,
  type EditorAction,
  type FieldErrors,
  type ListingDetailsForm,
  type ListingFailure,
} from "@/lib/listing";
import type { LatLng } from "@/lib/prototype/data";
import { ha } from "@/lib/prototype/format";
import { perimeterKm, type PolygonProblemCode } from "@/lib/prototype/geo";

import { BoundaryMap, type Basemap } from "./boundary-map";
import { DrawingDock, MapActions, PlaceSearch } from "./map-controls";
import { FailureAlert, FieldError, PolygonProblems, StepCard } from "./shared";

/** A world view until the steward finds their land (or a saved boundary is shown). */
const WORLD_VIEW: LatLng = [15, -40];
/** Set once a steward has finished a shape or hidden the tips: no more first-time hints. */
const TIPS_DONE_KEY = "nx-boundary-tips-done";

const CHECKED_TEXT: Record<
  Extract<BoundaryHint, { ok: true }>["checked"],
  string
> = {
  all: "Shape, size and overlap look right. NatureX checks again when you save.",
  "no-overlap":
    "Shape and size look right. NatureX checks overlaps with other sites when you save.",
  size: "The size looks right. This boundary is too detailed to check here: NatureX checks its shape and overlaps when you save.",
};

/** A few words for the map's dock; the side panel has the full sentence. */
const SHORT_PROBLEM: Record<PolygonProblemCode, string> = {
  too_few: "Add corners",
  too_complex: "Too detailed",
  self_intersection: "Edges cross",
  too_small: "Under 10 ha",
  too_large: "Over 50,000 ha",
  overlap: "Overlaps a listed site",
};

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function readTipsDone(): boolean {
  try {
    return window.localStorage.getItem(TIPS_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeTipsDone() {
  try {
    window.localStorage.setItem(TIPS_DONE_KEY, "1");
  } catch {
    // Private mode: the tips show again next time, which is fine.
  }
}

/** Step 2: draw (or type, or paste) the boundary, then save the draft. */
export function BoundaryStep({
  community,
  asset,
  form,
  points,
  setPoints,
  onBack,
  onSaved,
  onDetailsRejected,
}: {
  community: MyCommunity;
  asset: AssetDetail | null;
  form: ListingDetailsForm;
  points: LatLng[];
  setPoints: (points: LatLng[]) => void;
  onBack: () => void;
  onSaved: (asset: AssetDetail) => void;
  onDetailsRejected: (errors: FieldErrors) => void;
}) {
  const create = useCreateListing();
  const update = useUpdateListing();
  const outlines = useAssetOutlines();
  // A second click while the first save is in flight must not create a second draft.
  const saving = useRef(false);
  const [failure, setFailure] = useState<ListingFailure | null>(null);
  const [editor, setEditor] = useState(() => initialEditor(points));
  // Map gestures can dispatch twice before a re-render: reduce from the latest state.
  const editorRef = useRef(editor);
  const [focus, setFocus] = useState<MapFocus | null>(() =>
    points.length ? { bounds: points } : null,
  );
  const [coords, setCoords] = useState("");
  const [coordsError, setCoordsError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [labels, setLabels] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [tipsDone, setTipsDone] = useState(true);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => setTipsDone(readTipsDone()), []);

  const current = editor.points;
  const others = useMemo(
    () => outlinePolygons(outlines.data?.outlines, asset?.id),
    [outlines.data, asset?.id],
  );
  const complete = outlines.data ? !outlines.data.truncated : false;
  const hint = useMemo(
    () => boundaryHint(current, others, { complete }),
    [current, others, complete],
  );
  const issues = useMemo(
    () => boundaryIssues(current, others),
    [current, others],
  );
  const perimeter = useMemo(() => perimeterKm(current), [current]);
  const saved = asset ? boundaryPoints(asset.geojson) : null;
  const changed = !saved || !sameBoundary(saved, current);
  const pending = create.isPending || update.isPending;

  function dispatch(action: EditorAction) {
    if (pending) return;
    const next = editorReducer(editorRef.current, action);
    if (next === editorRef.current) return;
    editorRef.current = next;
    setEditor(next);
    if (next.points !== points) setPoints(next.points);
    setFailure(null);
    if (action.type === "finish") hideTips();
  }

  function hideTips() {
    setTipsDone(true);
    writeTipsDone();
  }

  // Full screen: lock the page behind the map and leave with Escape.
  useEffect(() => {
    if (!expanded) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      // Radix layers (popovers, tooltips) mark the Escape they used with preventDefault.
      if (event.key === "Escape" && !event.defaultPrevented) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  function onStageKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && !typing(event.target) && (key === "z" || key === "y")) {
      event.preventDefault();
      dispatch({ type: key === "y" || event.shiftKey ? "redo" : "undo" });
    } else if (
      event.key === "Enter" &&
      (event.target as HTMLElement).getAttribute("role") === "application"
    ) {
      event.preventDefault();
      dispatch({ type: "finish" });
    } else if (event.key === "Tab" && expanded && stage.current) {
      // Full screen covers the page: keep Tab within the map's controls.
      const focusable = stage.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  function typedCoordinates(): LatLng | null {
    const target = parseCoordinates(coords);
    setCoordsError(
      target ? null : "Type latitude, longitude, such as 19.29, -99.10.",
    );
    return target;
  }

  function goTo(event: React.FormEvent) {
    event.preventDefault();
    const target = typedCoordinates();
    if (target) setFocus({ center: target, zoom: 14 });
  }

  function addTypedCorner() {
    const target = typedCoordinates();
    if (!target) return;
    dispatch({ type: "add", point: target });
    if (!current.length) setFocus({ center: target, zoom: 14 });
  }

  function applyPasted() {
    const parsed = parseBoundary(pasted);
    if (!parsed.ok) return setPasteError(parsed.message);
    setPasteError(null);
    dispatch({ type: "replace", points: parsed.points });
    setFocus({ bounds: parsed.points });
  }

  async function save() {
    if (saving.current) return;
    saving.current = true;
    setFailure(null);
    const geojson = toPolygonGeoJson(current);
    try {
      if (!asset) {
        const created = await create.mutateAsync({
          community_id: community.id,
          ...detailsBody(form),
          geojson,
          attestation: form.attestation,
        });
        onSaved(created);
      } else if (changed) {
        onSaved(
          await update.mutateAsync({ assetId: asset.id, body: { geojson } }),
        );
      } else onSaved(asset);
    } catch (error) {
      if (asset && (error as ApiError).code === "no_changes")
        return onSaved(asset);
      const next = listingFailure(error as ApiError);
      if (!next.polygon.length && Object.keys(next.fields).length)
        return onDetailsRejected(next.fields);
      setFailure(next);
    } finally {
      saving.current = false;
    }
  }

  const km = perimeter < 10 ? perimeter.toFixed(2) : perimeter.toFixed(1);
  const readout =
    current.length >= 3 && hint
      ? `${ha(hint.areaHa)} · ${km} km`
      : current.length
        ? `${current.length} of 3 corners`
        : null;
  const status =
    hint && current.length >= 3
      ? hint.ok
        ? { ok: true, text: "Looks right" }
        : { ok: false, text: SHORT_PROBLEM[hint.code] }
      : null;

  return (
    <StepCard className="p-3 sm:p-6 lg:p-8">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <div
            ref={stage}
            onKeyDown={onStageKey}
            className={cn(
              "relative overflow-hidden bg-secondary",
              expanded
                ? "fixed inset-0 z-50 h-dvh rounded-none"
                : "h-[min(64dvh,680px)] min-h-[380px] rounded-3xl lg:h-[min(76dvh,820px)]",
            )}
          >
            <BoundaryMap
              points={current}
              mode={editor.mode}
              dispatch={dispatch}
              center={current[0] ?? WORLD_VIEW}
              zoom={current.length ? 14 : 2}
              focus={focus}
              others={others}
              issues={issues}
              valid={hint?.ok ?? true}
              basemap={basemap}
              labels={labels}
              label="Boundary map. Click to add corners. You can also type coordinates or paste a GeoJSON boundary."
            />
            <TooltipProvider delayDuration={300}>
              <div className="pointer-events-none absolute inset-x-3 top-3 z-[1000] flex items-start justify-between gap-2 [&>*]:pointer-events-auto">
                <PlaceSearch onPick={setFocus} className="min-w-0 flex-1" />
                <MapActions
                  basemap={basemap}
                  onBasemap={setBasemap}
                  labels={labels}
                  onLabels={setLabels}
                  expanded={expanded}
                  onExpanded={setExpanded}
                  onLocate={setFocus}
                />
              </div>
              <div className="pointer-events-none absolute bottom-7 left-3 z-[1000] max-w-[calc(100%-4.5rem)] [&>*]:pointer-events-auto">
                <DrawingDock
                  mode={editor.mode}
                  corners={current.length}
                  canUndo={editor.past.length > 0}
                  canRedo={editor.future.length > 0}
                  dispatch={dispatch}
                  readout={readout}
                  status={status}
                  hint={tipsDone ? null : drawingHint(editor)}
                  onDismissHint={hideTips}
                  disabled={pending}
                />
              </div>
            </TooltipProvider>
          </div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={goTo}>
            <div className="min-w-48 flex-1 space-y-1">
              <Label htmlFor="listing-go-to">Coordinates</Label>
              <Input
                id="listing-go-to"
                value={coords}
                onChange={(e) => setCoords(e.target.value)}
                placeholder="19.29, -99.10"
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={Boolean(coordsError)}
                aria-describedby={
                  coordsError ? "listing-go-to-error" : undefined
                }
              />
            </div>
            <Button type="submit" variant="outline">
              <Crosshair aria-hidden="true" />
              Go there
            </Button>
            <Button type="button" variant="outline" onClick={addTypedCorner}>
              <MapPinPlus aria-hidden="true" />
              Add a corner here
            </Button>
            <FieldError
              id="listing-go-to-error"
              message={coordsError ?? undefined}
            />
          </form>
          <details className="rounded-2xl border border-dashed border-input p-4 text-sm">
            <summary className="cursor-pointer font-medium">
              Paste a boundary instead (GeoJSON)
            </summary>
            <div className="mt-3 space-y-2">
              <Label htmlFor="listing-geojson" className="sr-only">
                GeoJSON boundary
              </Label>
              <Textarea
                id="listing-geojson"
                rows={4}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder='{"type": "Polygon", "coordinates": [[[lon, lat], …]]}'
                className="max-h-48 font-mono text-xs"
                spellCheck={false}
                aria-invalid={Boolean(pasteError)}
                aria-describedby={
                  pasteError ? "listing-geojson-error" : undefined
                }
              />
              <FieldError
                id="listing-geojson-error"
                message={pasteError ?? undefined}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={applyPasted}
                disabled={!pasted.trim()}
              >
                <ClipboardPaste aria-hidden="true" />
                Use this boundary
              </Button>
            </div>
          </details>
        </div>
        <div className="flex flex-col gap-4 px-1 pb-1 sm:px-0 sm:pb-0">
          <div>
            <h2 className="text-lg font-semibold">Draw the boundary</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Find your land, then click the map to add corners around it. Click
              the first corner or Finish to close the shape.
            </p>
          </div>
          <div className="rounded-2xl bg-secondary p-4" aria-live="polite">
            <div className="text-xs text-muted-foreground">Area (estimate)</div>
            <div className="tabular text-3xl font-light">
              {hint ? ha(hint.areaHa) : "0 ha"}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <span>{current.length.toLocaleString("en-US")} corners</span>
              {current.length >= 3 && (
                <span className="tabular">{km} km around</span>
              )}
            </div>
            {hint && !hint.ok && (
              <p className="mt-2 text-sm text-clay-ink">{hint.message}</p>
            )}
            {hint?.ok && (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-lime-ink">
                <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {CHECKED_TEXT[hint.checked]}
              </p>
            )}
          </div>
          {failure &&
            (failure.polygon.length > 0 ? (
              <PolygonProblems problems={failure.polygon} />
            ) : (
              <FailureAlert failure={failure} community={community} />
            ))}
          <details className="group text-sm">
            <summary className="cursor-pointer font-medium">
              How to edit the shape
            </summary>
            <ul className="mt-2 space-y-1.5 text-muted-foreground">
              <li>Drag a corner to move it.</li>
              <li>
                Drag or click the small dot between two corners to add one.
              </li>
              <li>
                Right-click a corner, or focus it and press Delete, to remove
                it.
              </li>
              <li>Focus a corner with Tab and move it with the arrow keys.</li>
              <li>Undo with Ctrl+Z (⌘Z on a Mac); redo with Ctrl+Shift+Z.</li>
            </ul>
          </details>
          <p className="text-xs text-muted-foreground">
            Sites must be 10–50,000 ha. Dashed outlines are sites already
            listed; boundaries can&apos;t overlap them.
          </p>
          <div className="mt-auto flex justify-between">
            <Button variant="ghost" onClick={onBack} disabled={pending}>
              Back
            </Button>
            <Button
              onClick={() => void save()}
              disabled={current.length < 3 || pending}
            >
              {pending
                ? "Saving…"
                : asset
                  ? changed
                    ? "Save boundary"
                    : "Continue"
                  : "Save draft"}
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </StepCard>
  );
}
