"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { price as fmtPrice, shortDate } from "@/lib/prototype/format";

const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };

function ChartTooltip({
  active,
  payload,
  label,
  format,
  labelOf = (l) => String(l ?? ""),
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string | number;
  format: (v: number) => string;
  labelOf?: (label: string | number | undefined) => string;
}) {
  if (!active || !payload?.length) return null;
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

export type ChartEvent = { id: string; date: string; direction: number | null };

const DAY_MS = 86_400_000;

function timeLabel(ms: number) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
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
 * price in force when it happened; events outside the recorded range are left off.
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
  const end = data.at(-1)?.t ?? 0;
  const marks = events.flatMap((e) => {
    const at = Date.parse(e.date);
    if (!Number.isFinite(at) || at < start || at > end) return [];
    const point = data.filter((d) => d.t <= at).at(-1);
    return point ? [{ t: at, price: point.price, event: e }] : [];
  });
  return { data, marks };
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
  const { data, marks } = priceSeries(prices, events, perDay);
  const start = data[0]?.t ?? 0;
  const end = data.at(-1)?.t ?? 0;
  const intraday = end - start < 2 * DAY_MS;
  const tick = (ms: number) => (intraday ? timeLabel(ms) : dayLabel(ms));
  const label = (ms: number) =>
    intraday ? `${dayLabel(ms)} ${timeLabel(ms)}` : dayLabel(ms);
  const rerates = data.filter(
    (d) => d.reason === "rerate" || d.reason === "ipo",
  );

  return (
    <div
      style={{ height }}
      className="w-full"
      role="img"
      aria-label={priceSummary(data)}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
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
            type="monotone"
            dataKey="price"
            stroke="var(--primary)"
            strokeWidth={1.75}
            fill="url(#price-fill)"
            isAnimationActive={false}
          />
          {rerates.map((d) => (
            <ReferenceDot
              key={`r-${d.t}`}
              x={d.t}
              y={d.price}
              r={4}
              fill="var(--card)"
              stroke="var(--primary)"
              strokeWidth={2}
            />
          ))}
          {marks.map((m) => (
            <ReferenceDot
              key={`e-${m.event.id}`}
              x={m.t}
              y={m.price}
              r={6}
              fill={
                (m.event.direction ?? 0) < 0 ? "var(--clay)" : "var(--lime-ink)"
              }
              stroke="var(--card)"
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A short text version of the NDVI series for screen readers. */
export function ndviSummary(series: [string, number][]) {
  if (series.length === 0) return "No NDVI series.";
  const values = series.map(([, v]) => v);
  return `Monthly NDVI, ${series.length} months from ${series[0]![0]} to ${series.at(-1)![0]}, between ${Math.min(...values).toFixed(2)} and ${Math.max(...values).toFixed(2)}.`;
}

export function NdviChart({
  series,
  height = 200,
}: {
  series: [string, number][];
  height?: number;
}) {
  const data = series.map(([m, v]) => ({ m, v }));
  return (
    <div
      style={{ height }}
      className="w-full"
      role="img"
      aria-label={ndviSummary(series)}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="m"
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            minTickGap={36}
            ticks={data.filter((d) => d.m.endsWith("-01")).map((d) => d.m)}
            tickFormatter={(m: string) => m.slice(0, 4)}
          />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={36}
            domain={[
              (min: number) => Math.min(0.3, Math.floor(min * 10) / 10),
              1,
            ]}
          />
          <Tooltip
            content={<ChartTooltip format={(v) => `NDVI ${v.toFixed(3)}`} />}
          />
          <Line
            type="monotone"
            dataKey="v"
            stroke="var(--grade-aa)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
