"use client";

import {
  Check,
  Eraser,
  Layers,
  LoaderCircle,
  LocateFixed,
  Maximize2,
  Minimize2,
  Redo2,
  Search,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "cn";

import type { MapFocus } from "@/components/proto/draw-map";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ApiError } from "@/lib/api/errors";
import type { PlaceOut, PlaceSearchOut } from "@/lib/api/types";
import { usePlaceSearch } from "@/lib/hooks";
import type { DrawMode, EditorAction } from "@/lib/listing";

import type { Basemap } from "./boundary-map";

/** Card-coloured floating surfaces on the map share this look. */
export const FLOAT = "bg-card/95 shadow-lift backdrop-blur-sm";

/** Nominatim's policy: at most one search a second from this tab. */
const MIN_SEARCH_GAP_MS = 1000;

function placeFocus(place: PlaceOut): MapFocus {
  if (place.bbox) {
    const [south, west, north, east] = place.bbox;
    return {
      bounds: [
        [south, west],
        [north, east],
      ],
    };
  }
  return { center: [place.lat, place.lon], zoom: 14 };
}

/**
 * Find a place by name and fly there. Searches run on submit (never per keystroke), at most
 * once a second, and repeat searches come from this tab's cache.
 */
export function PlaceSearch({
  onPick,
  className,
}: {
  onPick: (focus: MapFocus) => void;
  className?: string;
}) {
  const search = usePlaceSearch();
  const inputId = useId();
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, PlaceSearchOut>());
  const lastAt = useRef(0);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PlaceSearchOut | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Close the results on a click or tap anywhere else (the map included).
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function pick(place: PlaceOut) {
    setActive(place.label);
    onPick(placeFocus(place));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = query.trim().replace(/\s+/g, " ");
    if (text.length < 2) {
      setMessage("Type a place name, such as a town or a lake.");
      return;
    }
    const key = text.toLowerCase();
    let result = cache.current.get(key);
    setMessage(null);
    if (!result) {
      setBusy(true);
      try {
        const wait = lastAt.current + MIN_SEARCH_GAP_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastAt.current = Date.now();
        result = await search.mutateAsync(text);
        cache.current.set(key, result);
      } catch (error) {
        setFound(null);
        setMessage((error as ApiError).message);
        return;
      } finally {
        setBusy(false);
      }
    }
    setFound(result);
    setOpen(true);
    if (result.results.length) pick(result.results[0]);
    else
      setMessage(`No places found for “${text}”. Try a nearby town or region.`);
  }

  const results = found?.results ?? [];
  return (
    <div ref={root} className={cn("w-full max-w-sm", className)}>
      <form
        role="search"
        onSubmit={(e) => void submit(e)}
        className={cn("flex items-center gap-1 rounded-full p-1 pl-3.5", FLOAT)}
      >
        <Search
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <Label htmlFor={inputId} className="sr-only">
          Search for a place
        </Label>
        <Input
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => found && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          placeholder="Search for a place"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={120}
          aria-controls={open && results.length ? listId : undefined}
          aria-expanded={open && results.length > 0}
          aria-describedby={message ? `${inputId}-message` : undefined}
          className="h-9 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
        />
        <Button type="submit" size="sm" disabled={busy} className="shrink-0">
          {busy ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : null}
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      {message && (
        <p
          id={`${inputId}-message`}
          role="status"
          className={cn("mt-2 rounded-2xl px-3.5 py-2 text-sm", FLOAT)}
        >
          {message}
        </p>
      )}
      {open && results.length > 0 && (
        <div className={cn("nx-rise mt-2 overflow-hidden rounded-2xl", FLOAT)}>
          <ul
            id={listId}
            aria-label="Places found"
            className="max-h-64 overflow-y-auto p-1"
          >
            {results.map((place) => (
              <li key={`${place.label}:${place.lat}:${place.lon}`}>
                <button
                  type="button"
                  aria-current={active === place.label ? "true" : undefined}
                  onClick={() => {
                    pick(place);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring aria-[current]:bg-secondary aria-[current]:font-medium"
                >
                  <span className="line-clamp-2">{place.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground">
            {found?.attribution}
          </p>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  shortcut,
  children,
  className,
  ...rest
}: React.ComponentProps<typeof Button> & {
  label: string;
  shortcut?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          aria-keyshortcuts={shortcut}
          className={cn("size-10 rounded-full", className)}
          {...rest}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && (
          <span className="ml-1.5 opacity-70">
            {shortcut.replace("Control+", "Ctrl+")}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** Top-right column: map style, my location and full screen. */
export function MapActions({
  basemap,
  onBasemap,
  labels,
  onLabels,
  expanded,
  onExpanded,
  onLocate,
}: {
  basemap: Basemap;
  onBasemap: (value: Basemap) => void;
  labels: boolean;
  onLabels: (value: boolean) => void;
  expanded: boolean;
  onExpanded: (value: boolean) => void;
  onLocate: (focus: MapFocus) => void;
}) {
  const labelsId = useId();
  const [canLocate, setCanLocate] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  useEffect(() => setCanLocate("geolocation" in navigator), []);

  function locate() {
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocating(false);
        onLocate({ center: [coords.latitude, coords.longitude], zoom: 15 });
      },
      () => {
        setLocating(false);
        setLocateError(
          "We couldn't get your location. Search for a place instead.",
        );
      },
      { timeout: 10_000, maximumAge: 60_000 },
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className={cn("flex flex-col rounded-full p-1", FLOAT)}>
        <Popover modal>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Map style"
                  className="size-10 rounded-full"
                >
                  <Layers aria-hidden="true" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="left">Map style</TooltipContent>
          </Tooltip>
          <PopoverContent side="left" align="start" className="w-64 space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium" id={`${labelsId}-style`}>
                Map style
              </p>
              <ToggleGroup
                type="single"
                value={basemap}
                onValueChange={(v) =>
                  (v === "satellite" || v === "map") && onBasemap(v)
                }
                aria-labelledby={`${labelsId}-style`}
                className="w-full rounded-full bg-secondary p-1"
              >
                {(
                  [
                    ["satellite", "Satellite"],
                    ["map", "Street map"],
                  ] as const
                ).map(([value, text]) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    className="flex-1 rounded-full data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  >
                    {text}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={labelsId} className="font-normal">
                Place names on satellite
              </Label>
              <Switch
                id={labelsId}
                checked={labels}
                onCheckedChange={onLabels}
                disabled={basemap !== "satellite"}
              />
            </div>
          </PopoverContent>
        </Popover>
        {canLocate && (
          <IconButton
            label="Go to my location"
            onClick={locate}
            disabled={locating}
          >
            {locating ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <LocateFixed aria-hidden="true" />
            )}
          </IconButton>
        )}
        <IconButton
          label={expanded ? "Exit full screen" : "Full screen"}
          shortcut={expanded ? "Escape" : undefined}
          onClick={() => onExpanded(!expanded)}
          aria-pressed={expanded}
        >
          {expanded ? (
            <Minimize2 aria-hidden="true" />
          ) : (
            <Maximize2 aria-hidden="true" />
          )}
        </IconButton>
      </div>
      {locateError && (
        <p
          role="status"
          className={cn("max-w-56 rounded-2xl px-3 py-2 text-xs", FLOAT)}
        >
          {locateError}
        </p>
      )}
    </div>
  );
}

/**
 * The floating dock: what to do next, the live readout and the drawing actions. `status` is
 * a few words (the full message is in the side panel's live region).
 */
export function DrawingDock({
  mode,
  corners,
  canUndo,
  canRedo,
  dispatch,
  readout,
  status,
  hint,
  onDismissHint,
  disabled,
}: {
  mode: DrawMode;
  corners: number;
  canUndo: boolean;
  canRedo: boolean;
  dispatch: (action: EditorAction) => void;
  readout: string | null;
  status: { ok: boolean; text: string } | null;
  hint: string | null;
  onDismissHint: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex max-w-full flex-col items-start gap-2">
      {hint && (
        <p
          className={cn(
            "nx-rise flex max-w-sm items-start gap-2 rounded-2xl py-2 pr-1.5 pl-3.5 text-sm",
            FLOAT,
          )}
        >
          <span className="py-0.5">{hint}</span>
          <button
            type="button"
            onClick={onDismissHint}
            aria-label="Hide drawing tips"
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </p>
      )}
      {(corners > 0 || canUndo || canRedo) && (
        <div
          className={cn(
            "flex max-w-full flex-wrap items-center gap-1 rounded-[1.75rem] p-1",
            FLOAT,
          )}
        >
          {readout && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
              {status &&
                (status.ok ? (
                  <Check className="size-4 text-lime-ink" aria-hidden="true" />
                ) : (
                  <TriangleAlert
                    className="size-4 text-clay-ink"
                    aria-hidden="true"
                  />
                ))}
              <span className="tabular font-medium">{readout}</span>
              {status && !status.ok && (
                <span className="text-clay-ink">{status.text}</span>
              )}
            </div>
          )}
          <div className="flex items-center gap-0.5">
            {mode === "drawing" && corners >= 3 && (
              <Button
                type="button"
                size="sm"
                onClick={() => dispatch({ type: "finish" })}
                disabled={disabled}
                aria-keyshortcuts="Enter"
                className="nx-rise mr-1"
              >
                <Check aria-hidden="true" />
                Finish
              </Button>
            )}
            <IconButton
              label="Undo"
              shortcut="Control+Z"
              onClick={() => dispatch({ type: "undo" })}
              disabled={!canUndo || disabled}
            >
              <Undo2 aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Redo"
              shortcut="Control+Shift+Z"
              onClick={() => dispatch({ type: "redo" })}
              disabled={!canRedo || disabled}
            >
              <Redo2 aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Clear"
              onClick={() => dispatch({ type: "clear" })}
              disabled={!corners || disabled}
            >
              <Eraser aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      )}
    </div>
  );
}
