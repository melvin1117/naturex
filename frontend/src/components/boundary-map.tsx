"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { boundaryView, type LonLatRing, TILE_SIZE } from "@/lib/boundary-map";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";

export type BoundaryFrame = { width: number; height: number };

/** A marketplace card's 16:9 thumbnail: at most 3 × 2 tiles. */
export const CARD_FRAME: BoundaryFrame = { width: 384, height: 216 };
/** A hero backdrop: sharper, since it spans the page. */
export const BACKDROP_FRAME: BoundaryFrame = { width: 960, height: 540 };

const pct = (part: number, whole: number) => `${(part / whole) * 100}%`;

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
  frame?: BoundaryFrame;
  /** Alt text; without it the map is decorative (e.g. a backdrop behind the title). */
  label?: string;
  className?: string;
  creditClassName?: string;
}) {
  const view = useMemo(() => boundaryView(rings, frame), [rings, frame]);
  const [failed, setFailed] = useState(false);
  if (!view || failed) return null;
  const { width, height } = view;
  return (
    <div className={cn("absolute inset-0", className)} data-boundary-map="">
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
              onError={() => setFailed(true)}
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
    </div>
  );
}
