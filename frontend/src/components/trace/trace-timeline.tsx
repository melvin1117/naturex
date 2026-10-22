"use client";

import { cn } from "cn";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type Bar, type Lane, seconds } from "@/lib/trace-view";

import { ACTOR_FILL, ActorIcon } from "./actor";

/** Bars of a lane in rows, so overlapping bars (parallel searches) sit one above the other. */
function packRows(bars: Bar[]): Bar[][] {
  const rows: Bar[][] = [];
  for (const bar of [...bars].sort((a, b) => a.startMs - b.startMs)) {
    const row = rows.find((r) => r.at(-1)!.endMs <= bar.startMs);
    if (row) row.push(bar);
    else rows.push([bar]);
  }
  return rows;
}

function ticks(totalMs: number): number[] {
  const step = totalMs > 40_000 ? 10_000 : totalMs > 12_000 ? 5_000 : 2_000;
  const out: number[] = [];
  for (let t = 0; t <= totalMs; t += step) out.push(t);
  return out;
}

/** Every call of the run on one time axis, one lane per actor (a waterfall). */
export function TraceTimeline({
  totalMs,
  lanes,
}: {
  totalMs: number;
  lanes: Lane[];
}) {
  if (!lanes.length || totalMs <= 0)
    return (
      <p className="text-sm text-machine-muted">
        This run has no timed steps to draw.
      </p>
    );
  const pct = (ms: number) => `${Math.min(100, (ms / totalMs) * 100)}%`;
  return (
    <figure>
      <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-x-4">
        <div />
        <div className="relative mb-2 h-5" aria-hidden="true">
          {ticks(totalMs).map((t) => (
            <span
              key={t}
              className="tabular absolute -translate-x-1/2 text-[11px] text-machine-muted first:translate-x-0"
              style={{ left: pct(t) }}
            >
              {seconds(t)}
            </span>
          ))}
        </div>
        {lanes.map((lane) => (
          <Lane key={lane.actor} lane={lane} pct={pct} totalMs={totalMs} />
        ))}
      </div>
      <figcaption className="mt-4 text-xs text-machine-muted">
        From the run&apos;s start to its seal ({seconds(totalMs)}). Super
        chooses a tool, then the tool runs; Tavily&apos;s searches run side by
        side.
      </figcaption>
      <table className="sr-only">
        <caption>Every call of the run, in time order</caption>
        <thead>
          <tr>
            <th>Actor</th>
            <th>Step</th>
            <th>Start</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {lanes
            .flatMap((l) => l.bars.map((b) => ({ lane: l, bar: b })))
            .sort((a, b) => a.bar.startMs - b.bar.startMs)
            .map(({ lane, bar }) => (
              <tr key={`${lane.actor}-${bar.id}`}>
                <td>{lane.label}</td>
                <td>{bar.label}</td>
                <td>{seconds(bar.startMs)}</td>
                <td>{seconds(bar.endMs - bar.startMs)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </figure>
  );
}

function Lane({
  lane,
  pct,
  totalMs,
}: {
  lane: Lane;
  pct: (ms: number) => string;
  totalMs: number;
}) {
  const rows = packRows(lane.bars);
  return (
    <>
      <div className="flex items-start gap-2 border-t border-machine-line py-2">
        <ActorIcon actor={lane.actor} className="size-5" />
        <span className="text-xs leading-5 text-machine-ink">{lane.label}</span>
      </div>
      <div
        className="relative space-y-1 border-t border-machine-line py-2"
        aria-hidden="true"
      >
        {rows.map((row, i) => (
          <div key={i} className="relative h-5">
            {row.map((bar) => {
              const wide = (bar.endMs - bar.startMs) / totalMs > 0.12;
              return (
                <Tooltip key={bar.id}>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={-1}
                      className={cn(
                        "absolute top-0 flex h-5 min-w-1.5 items-center overflow-hidden rounded-md px-1.5 text-[10px] font-medium whitespace-nowrap",
                        ACTOR_FILL[lane.actor],
                        bar.status !== "ok" &&
                          "opacity-60 outline outline-1 outline-clay",
                      )}
                      style={{
                        left: pct(bar.startMs),
                        width: `max(6px, calc(${pct(bar.endMs)} - ${pct(bar.startMs)}))`,
                      }}
                    >
                      {wide ? bar.label : ""}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="font-medium">{bar.label}</p>
                    <p className="text-xs opacity-80">{bar.detail}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
