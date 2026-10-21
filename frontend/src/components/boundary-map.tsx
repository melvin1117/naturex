"use client";

import Image from "next/image";
import {
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "cn";

import {
  boundaryView,
  type BoundaryView,
  type LonLatRing,
  TILE_SIZE,
} from "@/lib/boundary-map";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";

export type BoundaryFrame = { width: number; height: number };

/** A marketplace card's 16:9 thumbnail: at most 3 × 2 tiles. */
export const CARD_FRAME: BoundaryFrame = { width: 384, height: 216 };
/** A backdrop's frame before it's measured, or where layout isn't available. */
export const BACKDROP_FRAME: BoundaryFrame = { width: 960, height: 540 };
/** A measured frame larger than this is drawn smaller and scaled up, to bound the tiles. */
const MAX_FRAME_PIXELS = 1600 * 900;

const pct = (part: number, whole: number) => `${(part / whole) * 100}%`;

/** The element's size as a frame, capped at `MAX_FRAME_PIXELS`; null before it has a size. */
function measuredFrame(element: HTMLElement): BoundaryFrame | null {
  const { width, height } = element.getBoundingClientRect();
  if (width < 1 || height < 1) return null;
  const shrink = Math.min(1, Math.sqrt(MAX_FRAME_PIXELS / (width * height)));
  return {
    width: Math.round(width * shrink),
    height: Math.round(height * shrink),
  };
}

/** The frame to draw: the given one, or for "container" the element's measured size. */
function useFrame(
  frame: BoundaryFrame | "container",
  ref: RefObject<HTMLDivElement | null>,
): BoundaryFrame | null {
  const [measured, setMeasured] = useState<BoundaryFrame | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (frame !== "container" || !element) return;
    const update = () => {
      const next = measuredFrame(element) ?? BACKDROP_FRAME;
      setMeasured((prev) =>
        prev?.width === next.width && prev.height === next.height ? prev : next,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame, ref]);
  return frame === "container" ? measured : frame;
}

/**
 * The site's boundary outlined on satellite imagery (the drawing map's provider), covering its
 * positioned parent like `object-cover`. Tiles load lazily; if one fails, or there's no usable
 * outline, it renders nothing so the parent's placeholder shows. The imagery credit stays visible.
 */
export function BoundaryMap({
  rings,
  frame = CARD_FRAME,
  label,
  className,
  creditClassName,
}: {
  rings: readonly LonLatRing[];
  /** A fixed frame (cards: a bounded tile count), or "container" to fit the parent's shape. */
  frame?: BoundaryFrame | "container";
  /** Alt text; without it the map is decorative (e.g. a backdrop behind the title). */
  label?: string;
  className?: string;
  creditClassName?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const size = useFrame(frame, root);
  const view = useMemo(
    () => (size ? boundaryView(rings, size) : null),
    [rings, size],
  );
  const [failed, setFailed] = useState(false);
  // Nothing, so the placeholder shows; until measured, an empty box to measure.
  if (failed || (size && !view)) return null;
  return (
    <div
      ref={root}
      className={cn("absolute inset-0", className)}
      data-boundary-map={view ? "" : undefined}
    >
      {view && (
        <BoundaryLayers
          view={view}
          label={label}
          creditClassName={creditClassName}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function BoundaryLayers({
  view,
  label,
  creditClassName,
  onError,
}: {
  view: BoundaryView;
  label?: string;
  creditClassName?: string;
  onError: () => void;
}) {
  const { width, height } = view;
  return (
    <>
      <div className="[container-type:size] absolute inset-0 overflow-hidden">
        <div
          {...(label
            ? { role: "img", "aria-label": label }
            : { "aria-hidden": true })}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: `max(100cqw, calc(100cqh * ${width / height}))`,
            aspectRatio: `${width} / ${height}`,
          }}
        >
          {view.tiles.map((tile) => (
            <Image
              key={tile.url}
              src={tile.url}
              alt=""
              width={TILE_SIZE}
              height={TILE_SIZE}
              unoptimized
              loading="lazy"
              draggable={false}
              onError={onError}
              className="absolute max-w-none select-none"
              style={{
                left: pct(tile.left, width),
                top: pct(tile.top, height),
                // A hair wider than the tile, so scaled tiles show no seams.
                width: `calc(${pct(TILE_SIZE, width)} + 1px)`,
                height: `calc(${pct(TILE_SIZE, height)} + 1px)`,
              }}
            />
          ))}
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="absolute inset-0 size-full"
            aria-hidden="true"
          >
            {view.paths.map((d) => (
              <path
                key={d}
                d={d}
                fill="#d6f28a"
                fillOpacity={0.14}
                stroke="#d6f28a"
                strokeWidth={2.5}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        </div>
      </div>
      <p
        className={cn(
          "absolute bottom-1.5 left-2 z-10 rounded-sm bg-black/45 px-1 text-[10px] leading-4 text-white",
          creditClassName,
        )}
      >
        {IMAGERY_ATTRIBUTION}
      </p>
    </>
  );
}
