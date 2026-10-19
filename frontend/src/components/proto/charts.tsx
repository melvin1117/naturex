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

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const points = perDay
    ? [...new Map(prices.map((p) => [p.t.slice(0, 10), p])).values()]
    : prices;
  const days = new Set(points.map((p) => p.t.slice(0, 10))).size;
  const data = points.map((p, i) => ({
    i,
    t: p.t,
    label:
      days > 1 || p.t.length <= 10
        ? shortDate(p.t)
        : `${shortDate(p.t)} ${timeLabel(p.t)}`,
    price: p.price,
    reason: p.reason,
  }));
  const labelOf = (i: string | number | undefined) =>
    data[Number(i)]?.label ?? "";
  const rerates = data.filter(
    (d) => d.reason === "rerate" || d.reason === "ipo",
  );
  const marks = events
    .map((e) => {
      const point =
        data.find((d) => d.t.slice(0, 10) >= e.date.slice(0, 10)) ??
        data[data.length - 1];
      return point ? { ...point, event: e } : null;
    })
    .filter(Boolean) as ((typeof data)[number] & { event: ChartEvent })[];

  return (
    <div style={{ height }} className="w-full">
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
            dataKey="i"
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
            tickFormatter={labelOf}
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
            content={<ChartTooltip format={fmtPrice} labelOf={labelOf} />}
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
              key={`r-${d.i}`}
              x={d.i}
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
              x={m.i}
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

export function NdviChart({
  series,
  height = 200,
}: {
  series: [string, number][];
  height?: number;
}) {
  const data = series.map(([m, v]) => ({ m, v }));
  // Simple least-squares line for the eye; the report's trend uses Sen's slope.
  const n = data.length;
  const xs = data.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = data.reduce((a, b) => a + b.v, 0) / n;
  const slope =
    xs.reduce((acc, x, i) => acc + (x - mx) * (data[i].v - my), 0) /
    Math.max(
      1e-9,
      xs.reduce((acc, x) => acc + (x - mx) ** 2, 0),
    );
  const withTrend = data.map((d, i) => ({
    ...d,
    trend: my + slope * (i - mx),
  }));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={withTrend}
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
          <Line
            type="linear"
            dataKey="trend"
            stroke="var(--lilac)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
