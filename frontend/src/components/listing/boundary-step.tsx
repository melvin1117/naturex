"use client";

import {
  ArrowRight,
  Check,
  ClipboardPaste,
  Crosshair,
  MapPinPlus,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { DrawMap, type MapFocus } from "@/components/proto/draw-map";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, MyCommunity } from "@/lib/api/types";
import {
  useAssetOutlines,
  useCreateListing,
  useUpdateListing,
} from "@/lib/hooks";
import {
  boundaryHint,
  boundaryPoints,
  detailsBody,
  listingFailure,
  outlinePolygons,
  parseBoundary,
  parseCoordinates,
  sameBoundary,
  toPolygonGeoJson,
  type BoundaryHint,
  type FieldErrors,
  type ListingDetailsForm,
  type ListingFailure,
} from "@/lib/listing";
import type { LatLng } from "@/lib/prototype/data";
import { ha } from "@/lib/prototype/format";

import { FailureAlert, FieldError, PolygonProblems, StepCard } from "./shared";

/** A world view until the steward finds their land (or a saved boundary is shown). */
const WORLD_VIEW: LatLng = [15, -40];

const CHECKED_TEXT: Record<
  Extract<BoundaryHint, { ok: true }>["checked"],
  string
> = {
  all: "Shape, size and overlap look right. NatureX checks again when you save.",
  "no-overlap":
    "Shape and size look right. NatureX checks overlaps with other sites when you save.",
  size: "The size looks right. This boundary is too detailed to check here: NatureX checks its shape and overlaps when you save.",
};

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
  const [focus, setFocus] = useState<MapFocus | null>(() =>
    points.length ? { bounds: points } : null,
  );
  const [coords, setCoords] = useState("");
  const [coordsError, setCoordsError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<LatLng[] | null>(null);

  const others = useMemo(
    () => outlinePolygons(outlines.data?.outlines, asset?.id),
    [outlines.data, asset?.id],
  );
  const complete = outlines.data ? !outlines.data.truncated : false;
  const hint = useMemo(
    () => boundaryHint(points, others, { complete }),
    [points, others, complete],
  );
  const saved = asset ? boundaryPoints(asset.geojson) : null;
  const changed = !saved || !sameBoundary(saved, points);
  const pending = create.isPending || update.isPending;

  function change(next: LatLng[]) {
    setPoints(next);
    setFailure(null);
    setCleared(null);
  }

  function clear() {
    const previous = points;
    change([]);
    setCleared(previous);
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
    change([...points, target]);
    if (!points.length) setFocus({ center: target, zoom: 14 });
  }

  function applyPasted() {
    const parsed = parseBoundary(pasted);
    if (!parsed.ok) return setPasteError(parsed.message);
    setPasteError(null);
    change(parsed.points);
    setFocus({ bounds: parsed.points });
  }

  async function save() {
    if (saving.current) return;
    saving.current = true;
    setFailure(null);
    const geojson = toPolygonGeoJson(points);
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

  return (
    <StepCard>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <DrawMap
            points={points}
            onAdd={(p) => change([...points, p])}
            center={points[0] ?? WORLD_VIEW}
            zoom={points.length ? 14 : 2}
            focus={focus}
            others={others}
            valid={hint?.ok ?? true}
            label="Boundary map. Click to add corners. You can also type coordinates or paste a GeoJSON boundary."
          />
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
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">Draw the boundary</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Find your land, then click the map to add corners around it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => change(points.slice(0, -1))}
              disabled={!points.length || pending}
            >
              <Undo2 aria-hidden="true" />
              Undo corner
            </Button>
            {cleared && !points.length ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => change(cleared)}
                disabled={pending}
              >
                <Undo2 aria-hidden="true" />
                Undo clear
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={clear}
                disabled={!points.length || pending}
              >
                <RotateCcw aria-hidden="true" />
                Clear
              </Button>
            )}
          </div>
          <div className="rounded-2xl bg-secondary p-4" aria-live="polite">
            <div className="text-xs text-muted-foreground">Area (estimate)</div>
            <div className="tabular text-3xl font-light">
              {hint ? ha(hint.areaHa) : "0 ha"}
            </div>
            <div className="text-xs text-muted-foreground">
              {points.length.toLocaleString("en-US")} corners
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
              disabled={points.length < 3 || pending}
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
