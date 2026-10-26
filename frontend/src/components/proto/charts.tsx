"use client";

import { cn } from "cn";
import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  usePlotArea,
  XAxis,
  YAxis,
} from "recharts";

import { LoadingRegion } from "@/components/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { price as fmtPrice, shortDate } from "@/lib/format";

const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };

export function ChartTooltip({
  active,
  payload,
  label,
  format,
  labelOf = (l) => String(l ?? ""),
}: {
  active?: boolean;
  payload?: { value: number; payload?: { synthetic?: boolean } }[];
  label?: string | number;
  format: (v: number) => string;
  labelOf?: (label: string | number | undefined) => string;
}) {
  // A point drawn only to carry the line on to a later marker isn't a recorded price.
  if (!active || !payload?.length || payload[0].payload?.synthetic) return null;
  return (
    <div className="rounded-xl bg-card px-3 py-2 text-xs shadow-lift ring-1 ring-border">
      <div className="text-muted-foreground">{labelOf(label)}</div>
      <div className="tabular mt-0.5 text-sm font-medium">
        {format(payload[0].value)}
      </div>
    </div>
  );
}

export type ChartPrice = {
  /** ISO date or timestamp. */
  t: string;
  price: number;
  reason?: string | null;
};

export type ChartEvent = {
  id: string;
  date: string;
  direction: number | null;
  /** When WildWorth recorded it, which places it on the time axis; `date` if absent. */
  at?: string;
  title?: string;
};

export type ChartMarker = {
  key: string;
  /** 1-based, in time order: the number drawn on the marker and in the list. */
  n: number;
  t: number;
  price: number;
  kind: "ipo" | "rerate" | "event";
  label: string;
  direction: number | null;
  /** How many earlier markers sit on (nearly) the same point: fanned out that many slots. */
  stack: number;
};

export type PlotArea = { x: number; y: number; width: number; height: number };

const MARKER_R = 8;
// Radius plus half the stroke: the whole marker stays inside the plot.
const MARKER_PAD = MARKER_R + 1;
const MARKER_STEP = 18;
const MARKER_ROWS = 3;
const MARKER_COLUMNS = 2;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where a marker is drawn. One on its own sits on its point; markers on the same point stack
 * upwards (downwards near the top), then in a second column toward the middle of the chart,
 * at most `MARKER_ROWS × MARKER_COLUMNS` slots (later ones share the last). Always inside the
 * plot: never over the Y-axis labels, and one at the right edge (after the last price) stays
 * there.
 */
export function markerPosition(
  cx: number,
  cy: number,
  stack: number,
  plot: PlotArea | undefined,
): { x: number; y: number } {
  const slot = Math.min(stack, MARKER_ROWS * MARKER_COLUMNS - 1);
  const row = slot % MARKER_ROWS;
  const column = Math.floor(slot / MARKER_ROWS);
  if (!plot) return { x: cx, y: cy - row * MARKER_STEP };
  const top = plot.y + MARKER_PAD;
  const bottom = plot.y + plot.height - MARKER_PAD;
  const inward = cx > plot.x + plot.width / 2 ? -1 : 1;
  const up = cy - row * MARKER_STEP;
  return {
    x: clamp(
      cx + inward * column * MARKER_STEP,
      plot.x + MARKER_PAD,
      plot.x + plot.width - MARKER_PAD,
    ),
    y: clamp(up < top ? cy + row * MARKER_STEP : up, top, bottom),
  };
}

const DAY_MS = 86_400_000;

// UTC, like the day labels (`shortDate`), so a time never sits under another day's date.
function timeLabel(ms: number) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function dayLabel(ms: number) {
  return shortDate(new Date(ms).toISOString());
}

/** A short text version of the price series for screen readers. */
export function priceSummary(points: { t: number; price: number }[]) {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return "No prices recorded yet.";
  return `Stake price, ${points.length} recorded prices: ${fmtPrice(first.price)} on ${dayLabel(first.t)} to ${fmtPrice(last.price)} on ${dayLabel(last.t)}.`;
}

/**
 * Prices on a time axis (ms), oldest first, and the event markers: each event sits on the
 * price in force when it happened (the last price for an event recorded after it); events
 * before the first price are left off.
 */
export function priceSeries(
  prices: ChartPrice[],
  events: ChartEvent[],
  perDay: boolean,
) {
  const points = perDay
    ? [...new Map(prices.map((p) => [p.t.slice(0, 10), p])).values()]
    : prices;
  const data = points
    .map((p) => ({ t: Date.parse(p.t), price: p.price, reason: p.reason }))
    .filter((d) => Number.isFinite(d.t))
    .sort((a, b) => a.t - b.t);
  const start = data[0]?.t ?? 0;
  const marks = events.flatMap((e) => {
    const at = Date.parse(e.at ?? e.date);
    if (!Number.isFinite(at) || at < start) return [];
    const point = data.filter((d) => d.t <= at).at(-1);
    return point ? [{ t: at, price: point.price, event: e }] : [];
  });
  return { data, marks };
}

function eventLabel(e: ChartEvent) {
  const title = e.title?.trim() || "News event";
  const tone =
    (e.direction ?? 0) < 0
      ? "negative"
      : (e.direction ?? 0) > 0
        ? "positive"
        : null;
  return tone ? `${title} (${tone})` : title;
}

/**
 * Every marker on the chart, numbered in time order: the opening price, each re-rate (the
 * stored price with reason `ipo` / `rerate`) and each event on the price in force.
 */
export function chartMarkers({
  data,
  marks,
}: ReturnType<typeof priceSeries>): ChartMarker[] {
  const prices = data.flatMap((d) =>
    d.reason === "ipo" || d.reason === "rerate"
      ? [
          {
            key: `${d.reason}-${d.t}`,
            t: d.t,
            price: d.price,
            kind: d.reason,
            label:
              d.reason === "ipo"
                ? "Opening price"
                : "Re-rated: price moved toward the new fair price",
            direction: null,
          } as const,
        ]
      : [],
  );
  const events = marks.map(
    (m) =>
      ({
        key: `event-${m.event.id}`,
        t: m.t,
        price: m.price,
        kind: "event",
        label: eventLabel(m.event),
        direction: m.event.direction,
      }) as const,
  );
  const sorted = [...prices, ...events].sort((a, b) => a.t - b.t);
  const near = ((sorted.at(-1)?.t ?? 0) - (sorted[0]?.t ?? 0)) / 40;
  return sorted.map((m, i) => ({
    ...m,
    n: i + 1,
    stack: sorted
      .slice(0, i)
      .filter((o) => m.t - o.t <= near && o.price === m.price).length,
  }));
}

function markerColors(m: ChartMarker) {
  if (m.kind !== "event")
    return {
      fill: "var(--card)",
      stroke: "var(--primary)",
      ink: "var(--primary)",
    };
  const fill =
    (m.direction ?? 0) < 0
      ? "var(--clay)"
      : (m.direction ?? 0) > 0
        ? "var(--lime-ink)"
        : "var(--muted-foreground)";
  return { fill, stroke: "var(--card)", ink: "var(--card)" };
}

function markerClass(m: ChartMarker) {
  if (m.kind !== "event") return "border-primary bg-card text-primary";
  const tone = m.direction ?? 0;
  return cn(
    "border-card text-card",
    tone < 0 ? "bg-clay" : tone > 0 ? "bg-lime-ink" : "bg-muted-foreground",
  );
}

function MarkerShape({
  cx,
  cy,
  marker,
}: {
  cx?: number;
  cy?: number;
  marker: ChartMarker;
}) {
  const plot = usePlotArea();
  if (cx == null || cy == null) return <g />;
  const { fill, stroke, ink } = markerColors(marker);
  const { x, y } = markerPosition(cx, cy, marker.stack, plot);
  return (
    <g>
      <title>{`${marker.n}. ${marker.label}`}</title>
      <circle
        cx={x}
        cy={y}
        r={MARKER_R}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
      />
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={9}
        fontWeight={600}
        fill={ink}
      >
        {marker.n}
      </text>
    </g>
  );
}

export function PriceChart({
  prices,
  events,
  height = 280,
  perDay = true,
}: {
  prices: ChartPrice[];
  events: ChartEvent[];
  height?: number;
  /** Keep one point per day (the last); off shows every recorded price. */
  perDay?: boolean;
}) {
  const series = priceSeries(prices, events, perDay);
  const { data } = series;
  const markers = chartMarkers(series);
  const listId = useId();
  const start = data[0]?.t ?? 0;
  const last = data.at(-1);
  const end = Math.max(last?.t ?? 0, ...series.marks.map((m) => m.t));
  // The last price holds until the latest marker, so the line runs on to it.
  const plotted =
    last && end > last.t
      ? [...data, { ...last, t: end, reason: null, synthetic: true }]
      : data;
  const intraday = end - start < 2 * DAY_MS;
  const tick = (ms: number) => (intraday ? timeLabel(ms) : dayLabel(ms));
  const label = (ms: number) =>
    intraday ? `${dayLabel(ms)} ${timeLabel(ms)} UTC` : dayLabel(ms);

  return (
    <div>
      <div
        style={{ height }}
        className="w-full"
        role="img"
        aria-label={priceSummary(data)}
        aria-describedby={markers.length ? listId : undefined}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={plotted}
            margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--lime)" stopOpacity={0.55} />
                <stop offset="100%" stopColor="var(--lime)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
              tickFormatter={tick}
            />
            <YAxis
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              width={56}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => fmtPrice(v)}
            />
            <Tooltip
              content={
                <ChartTooltip
                  format={fmtPrice}
                  labelOf={(l) => (typeof l === "number" ? label(l) : "")}
                />
              }
              cursor={{ stroke: "var(--ring)" }}
            />
            <Area
              // Recorded prices hold until the next one: draw steps, not a curve between them.
              type={perDay ? "monotone" : "stepAfter"}
              dataKey="price"
              stroke="var(--primary)"
              strokeWidth={1.75}
              fill="url(#price-fill)"
              isAnimationActive={false}
            />
            {markers.map((m) => (
              <ReferenceDot
                key={m.key}
                x={m.t}
                y={m.price}
                shape={(props: { cx?: number; cy?: number }) => (
                  <MarkerShape cx={props.cx} cy={props.cy} marker={m} />
                )}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {markers.length > 0 && (
        <MarkerList id={listId} markers={markers} label={label} />
      )}
    </div>
  );
}

/** The markers as text: what each number on the chart is, when, and the price then. */
function MarkerList({
  id,
  markers,
  label,
}: {
  id: string;
  markers: ChartMarker[];
  label: (ms: number) => string;
}) {
  return (
    <div className="mt-4">
      <h4
        id={`${id}-title`}
        className="text-xs font-medium text-muted-foreground"
      >
        Marked on the chart
      </h4>
      <ol
        id={id}
        aria-labelledby={`${id}-title`}
        className="mt-2 space-y-1.5 text-sm"
      >
        {markers.map((m) => {
          return (
            <li key={m.key} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className={cn(
                  "tabular mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 text-[10px] font-semibold",
                  markerClass(m),
                )}
              >
                {m.n}
              </span>
              <span className="min-w-0">
                <span className="sr-only">{m.n}. </span>
                <span className="break-words">{m.label}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {label(m.t)} · {fmtPrice(m.price)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A short text version of the NDVI series for screen readers. */
export function ndviSummary(series: [string, number][]) {
  if (series.length === 0) return "No NDVI series.";
  const values = series.map(([, v]) => v);
  return `Monthly NDVI, ${series.length} months from ${series[0]![0]} to ${series.at(-1)![0]}, between ${Math.min(...values).toFixed(2)} and ${Math.max(...values).toFixed(2)}.`;
}

/**
 * The price chart while its history loads (#219): the plot's height, its axis labels and the
 * area as blocks, so the chart replaces it without a jump and without a spinner.
 */
export function PriceChartSkeleton({
  height = 280,
  label = "Loading prices…",
}: {
  height?: number;
  label?: string;
}) {
  return (
    <LoadingRegion name="price-chart" label={label}>
      <div style={{ height }} className="flex gap-2 pt-3">
        <div className="flex w-12 shrink-0 flex-col justify-between pb-7">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-3 w-10" />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Skeleton className="flex-1 rounded-2xl" />
          <div className="mt-3 flex h-4 items-center justify-between">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-3 w-12" />
            ))}
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
