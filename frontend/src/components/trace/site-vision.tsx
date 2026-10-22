import { cn } from "cn";

import { demoSiteMediaUrl } from "@/lib/demo-site-images";
import { type Vision, changeLabel, modelLabel } from "@/lib/trace-view";

const CELLS = [
  "north-west",
  "north",
  "north-east",
  "west",
  "centre",
  "east",
  "south-west",
  "south",
  "south-east",
] as const;

const ROWS: [string, string][] = [
  ["water", "Water"],
  ["vegetation", "Vegetation"],
  ["built_or_bare", "Built or bare ground"],
];

function View({
  src,
  label,
  marks,
  whole,
}: {
  src: string;
  label: string;
  marks?: Map<string, boolean | null>;
  whole?: boolean | null;
}) {
  return (
    <figure className="min-w-0">
      <div
        className={cn(
          "relative overflow-hidden rounded-2xl bg-machine",
          whole === true && "ring-2 ring-lime",
          whole === false && "ring-2 ring-clay",
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a committed demo image */}
        <img
          src={src}
          alt={label}
          className="block aspect-[8/5] w-full object-cover"
        />
        {marks && (
          <div
            className="absolute inset-0 grid grid-cols-3 grid-rows-3"
            aria-hidden="true"
          >
            {CELLS.map((cell) => {
              const agrees = marks.get(cell);
              return (
                <span
                  key={cell}
                  className={cn(
                    "border border-white/15",
                    agrees === true && "border-2 border-lime bg-lime/15",
                    agrees === false && "border-2 border-clay bg-clay/15",
                    agrees === null && "border-2 border-sky bg-sky/10",
                  )}
                />
              );
            })}
          </div>
        )}
      </div>
      <figcaption className="mt-1.5 text-xs text-machine-muted">
        {label}
      </figcaption>
    </figure>
  );
}

/** The vision model's reading: both views, the cells it pointed at, and code's check. */
export function SiteVisionView({
  siteKey,
  vision,
}: {
  siteKey: string | null | undefined;
  vision: Vision;
}) {
  const marks = new Map<string, boolean | null>();
  let whole: boolean | null | undefined;
  for (const c of vision.changes) {
    if (c.kind === "no_clear_change") continue;
    if (c.where === "whole site") whole = c.agrees;
    else marks.set(c.where, c.agrees);
  }
  return (
    <div className="space-y-4">
      {siteKey && (
        <div className="grid grid-cols-2 gap-2">
          <View
            src={demoSiteMediaUrl(siteKey, "before.webp")}
            label="Five years earlier"
          />
          <View
            src={demoSiteMediaUrl(siteKey, "thumbnail.webp")}
            label="Latest 12 months"
            marks={marks}
            whole={whole}
          />
        </div>
      )}
      {vision.before && vision.after && (
        <dl className="space-y-2 text-[13px] leading-snug">
          {ROWS.map(([key, label]) => (
            <div key={key}>
              <dt className="text-[11px] text-machine-muted">{label}</dt>
              <dd className="text-machine-ink/90">
                <span className="text-machine-muted">Then:</span>{" "}
                {vision.before?.[key]}
                <br />
                <span className="text-machine-muted">Now:</span>{" "}
                {vision.after?.[key]}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <ul className="space-y-2">
        {vision.changes.map((c) => (
          <li key={c.id} className="text-[13px] leading-snug">
            <span className="font-medium text-machine-ink">
              {changeLabel(c.kind)}
              {c.kind !== "no_clear_change" && ` · ${c.where}`}
            </span>
            <span className="text-machine-muted">
              {" "}
              · {c.confidence} confidence
            </span>
            <span className="block text-machine-ink/90">{c.note}</span>
            <span
              className={cn(
                "block text-xs",
                c.agrees === true && "text-lime",
                c.agrees === false && "text-clay",
                c.agrees === null && "text-machine-muted",
              )}
            >
              Code check: {c.check}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-machine-muted">
        {modelLabel(vision.model)} describes; it never measures. Each change is
        checked against the satellite metrics before the Auditor sees it.
        Contains modified Copernicus Sentinel data 2021–2026.
      </p>
    </div>
  );
}
