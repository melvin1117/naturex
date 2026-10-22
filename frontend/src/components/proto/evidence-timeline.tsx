"use client";

import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "cn";

import { ChartTooltip, ndviSummary } from "@/components/proto/charts";
import { Panel } from "@/components/proto/report-panels";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { DEMO_SITES, demoSiteMediaUrl } from "@/lib/demo-site-images";
import type { RecordedRun } from "@/lib/api/types";
import {
  type EvidenceTimeline,
  type NewsItem,
  type TimelineEntry,
  evidenceTimeline,
  mergeNews,
  traceNews,
} from "@/lib/evidence-timeline";
import { date } from "@/lib/prototype/format";
import { useRunTrace } from "@/lib/hooks";
import type { ReportFacts } from "@/lib/report-facts";
import {
  type Vision,
  changeLabel,
  runFollowUps,
  runSignals,
  runVision,
} from "@/lib/trace-view";

const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };
const TONE = {
  [-1]: "var(--clay)",
  0: "var(--muted-foreground)",
  1: "var(--grade-aa)",
} as Record<number, string>;
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

function monthName(month: string): string {
  const m = Number(month.slice(5, 7));
  return m ? `${MONTHS[m - 1]} ${month.slice(0, 4)}` : month;
}

function TimelineChart({
  series,
  timeline,
}: {
  series: [string, number][];
  timeline: EvidenceTimeline;
}) {
  const data = series.map(([m, v]) => ({ m: m.slice(0, 7), v }));
  const top = 1;
  const summary = [
    ndviSummary(series),
    timeline.bands.length
      ? `${timeline.bands.length} dated change${timeline.bands.length === 1 ? "" : "s"} marked.`
      : "",
    timeline.pins.length
      ? `${timeline.pins.reduce((n, p) => n + p.items.length, 0)} news items pinned.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="h-[240px] w-full" role="img" aria-label={summary}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 14, right: 10, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          {timeline.bands.map((b) => (
            <ReferenceArea
              key={b.id}
              x1={b.start}
              x2={b.end}
              fill={TONE[b.direction] ?? TONE[0]}
              fillOpacity={0.16}
              stroke="none"
              ifOverflow="extendDomain"
            />
          ))}
          {timeline.pins.map((p) => (
            <ReferenceLine
              key={`line-${p.month}`}
              x={p.month}
              stroke={TONE[p.direction] ?? TONE[0]}
              strokeOpacity={0.35}
              strokeDasharray="2 3"
            />
          ))}
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
              top,
            ]}
          />
          <Tooltip
            content={<ChartTooltip format={(v) => `NDVI ${v.toFixed(3)}`} />}
          />
          <Line
            type="monotone"
            dataKey="v"
            stroke="var(--grade-aa)"
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
          {timeline.pins.map((p) => (
            <ReferenceDot
              key={`pin-${p.month}`}
              x={p.month}
              y={top}
              r={p.items.length > 1 ? 6 : 4.5}
              fill={TONE[p.direction] ?? TONE[0]}
              stroke="var(--card)"
              strokeWidth={2}
              ifOverflow="visible"
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Legend() {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-3 w-4 rounded-[3px] bg-clay/25" />
        A month well below its seasonal normal (found by code)
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="h-3 w-4 rounded-[3px] bg-[var(--grade-aa)]/20"
        />
        Well above it
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2.5 rounded-full bg-clay" />
        Harmful news
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-2.5 rounded-full bg-[var(--grade-aa)]"
        />
        Good news
      </li>
    </ul>
  );
}

function EntryMarker({ entry }: { entry: TimelineEntry }) {
  const tone =
    entry.direction < 0
      ? "bg-clay"
      : entry.direction > 0
        ? "bg-[var(--grade-aa)]"
        : "bg-muted-foreground/60";
  return entry.type === "signal" ? (
    <span
      aria-hidden="true"
      className={cn("mt-1 h-3 w-4 shrink-0 rounded-[3px] opacity-60", tone)}
    />
  ) : (
    <span
      aria-hidden="true"
      className={cn("mt-1.5 ml-1 size-2 shrink-0 rounded-full", tone)}
    />
  );
}

function Entry({ entry }: { entry: TimelineEntry }) {
  const meta =
    entry.type === "signal"
      ? ["Satellite, found by code"]
      : [
          entry.source,
          entry.kind,
          entry.followUp ? "found by Super's follow-up search" : null,
          entry.read ? `article read: ${entry.read.verdict}` : null,
        ].filter(Boolean);
  return (
    <li className="grid grid-cols-[4.5rem_auto_minmax(0,1fr)] items-start gap-x-3 py-2">
      <span className="tabular pt-px text-xs text-muted-foreground">
        {monthName(entry.month)}
      </span>
      <EntryMarker entry={entry} />
      <span className="min-w-0 text-sm leading-snug">
        {entry.type === "news" && entry.url ? (
          <a
            href={entry.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-start gap-1 underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="line-clamp-2">{entry.title}</span>
            <ExternalLink
              className="mt-1 size-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="sr-only"> (opens the source in a new tab)</span>
          </a>
        ) : (
          <span>{entry.type === "signal" ? entry.text : entry.title}</span>
        )}
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {meta.join(" · ")}
        </span>
      </span>
    </li>
  );
}

const SHOWN = 8;

/** Five years of greenness with the run's dated signals, news pins and follow-ups. */
export function EvidenceTimelinePanel({
  facts,
  news,
  runId,
  siteKey,
  recorded,
}: {
  facts: ReportFacts;
  news: NewsItem[];
  runId: string | null | undefined;
  siteKey: string | null | undefined;
  /** A demo site's recorded run, used when this world has no run of its own. */
  recorded?: RecordedRun | null;
}) {
  const live = useRunTrace(runId);
  const run = live.data ?? (runId ? undefined : recorded?.trace);
  const fromRecording = !live.data && Boolean(run);
  const timeline = useMemo(
    () =>
      evidenceTimeline(
        facts.ndvi,
        run ? runSignals(run) : [],
        fromRecording && run && recorded
          ? mergeNews(
              news,
              traceNews(run, `Recorded run, ${date(recorded.recorded_on)}`),
            )
          : news,
        run ? runFollowUps(run) : [],
      ),
    [facts.ndvi, news, run, fromRecording, recorded],
  );
  const vision = run ? runVision(run) : null;
  const [all, setAll] = useState(false);
  const entries = all ? timeline.entries : timeline.entries.slice(-SHOWN);
  const demo = DEMO_SITES.some((s) => s.key === siteKey);
  const label = facts.trendLabel;

  return (
    <>
      <Panel
        title="Five years of greenness, and what explains it"
        action={
          label && (
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium",
                label === "Declining"
                  ? "bg-clay/15 text-clay-ink"
                  : "bg-lime/30 text-lime-ink",
              )}
            >
              {label}
            </span>
          )
        }
      >
        {facts.ndvi.length > 1 ? (
          <>
            <TimelineChart series={facts.ndvi} timeline={timeline} />
            <Legend />
          </>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No monthly NDVI series is stored with this report.
          </p>
        )}

        {timeline.followUps.length > 0 && (
          <div className="mt-5 rounded-2xl bg-muted/60 px-4 py-3">
            <p className="text-sm font-medium">
              Nemotron 3 Super followed up before the audit
              {fromRecording && recorded && (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  (recorded run, {date(recorded.recorded_on)})
                </span>
              )}
            </p>
            <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
              {timeline.followUps.map((note, i) => (
                <li key={`${i}-${note}`}>{note}</li>
              ))}
            </ul>
          </div>
        )}

        {timeline.entries.length > 0 && (
          <section className="mt-5" aria-labelledby="timeline-list">
            <h4 id="timeline-list" className="text-sm font-medium">
              On the timeline
            </h4>
            <ol className="mt-1 divide-y divide-border">
              {entries.map((e) => (
                <Entry key={`${e.type}-${e.id}`} entry={e} />
              ))}
            </ol>
            {timeline.entries.length > SHOWN && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setAll((a) => !a)}
                aria-expanded={all}
                className="mt-2 h-auto px-0 text-lime-ink"
              >
                {all
                  ? "Show the latest only"
                  : `Show all ${timeline.entries.length}`}
              </Button>
            )}
          </section>
        )}

        {facts.ndviTrend !== null && (
          <p className="mt-4 text-xs text-muted-foreground">
            Monthly Sentinel-2 NDVI, cloud-masked. Trend{" "}
            {facts.ndviTrend >= 0 ? "+" : ""}
            {facts.ndviTrend.toFixed(4)} a year (Sen&apos;s slope
            {facts.ndviP !== null &&
              `, Mann–Kendall p ${facts.ndviP < 0.01 ? "< 0.01" : `= ${facts.ndviP.toFixed(2)}`}`}
            ). Each month is compared with the same month in the other years, so
            a normal dry season is not marked.
          </p>
        )}
      </Panel>
      {demo && siteKey && (
        <BeforeAfterPanel
          siteKey={siteKey}
          vision={vision}
          recordedOn={fromRecording ? recorded?.recorded_on : undefined}
        />
      )}
    </>
  );
}

/** The site's Sentinel-2 views five years apart, under one slider, with the vision reading. */
function BeforeAfterPanel({
  siteKey,
  vision,
  recordedOn,
}: {
  siteKey: string;
  vision: Vision | null;
  /** Set when the reading comes from the site's recorded run. */
  recordedOn?: string;
}) {
  const [at, setAt] = useState(50);
  const reading = vision && !vision.error ? vision : null;
  const changes = reading?.changes.filter((c) => c.kind !== "no_clear_change");
  return (
    <Panel title="Five years apart, seen from above">
      <div className="relative aspect-[16/10] overflow-hidden rounded-2xl bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- same-origin media proxy */}
        <img
          src={demoSiteMediaUrl(siteKey, "thumbnail.webp")}
          alt="The site in the latest 12 months"
          className="absolute inset-0 size-full object-cover"
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- same-origin media proxy */}
        <img
          src={demoSiteMediaUrl(siteKey, "before.webp")}
          alt="The site five years earlier"
          className="absolute inset-0 size-full object-cover"
          style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
          style={{ left: `calc(${at}% - 1px)` }}
        />
        <span className="absolute top-3 left-3 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white">
          Five years earlier
        </span>
        <span className="absolute top-3 right-3 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white">
          Latest 12 months
        </span>
      </div>
      <Slider
        value={[at]}
        onValueChange={([v]) => setAt(v ?? 50)}
        min={0}
        max={100}
        step={1}
        aria-label="Compare the two views: drag to reveal more of the earlier one"
        className="mt-4"
      />
      {reading && (
        <div className="mt-4 text-sm">
          <p className="font-medium">
            Nemotron 3.5 Super VL
            {recordedOn && (
              <span className="font-normal text-muted-foreground">
                {" "}
                (recorded run, {date(recordedOn)})
              </span>
            )}
            :{" "}
            {changes?.length
              ? changes
                  .map((c) => `${changeLabel(c.kind)} (${c.where})`)
                  .join(", ")
              : "no clear change between the two views"}
          </p>
          <p className="mt-1 text-muted-foreground">
            {changes?.length
              ? changes.map((c) => c.check).join(" ")
              : "Code checked this against the satellite metrics before the Auditor saw it."}{" "}
            The model describes; it never measures.
          </p>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Sentinel-2 true-colour composites with the site&apos;s outline. Contains
        modified Copernicus Sentinel data 2021–2026.
      </p>
    </Panel>
  );
}
