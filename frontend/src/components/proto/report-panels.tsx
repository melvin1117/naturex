"use client";

import { Check, Flag, Layers } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "cn";

import {
  ProofOfLifeSeal,
  ProofOfLifeShareCard,
} from "@/components/brand/proof-of-life";
import { MarkdownText } from "@/components/markdown-text";
import { GradeBadge } from "@/components/proto/grade";
import { ReportChanges } from "@/components/proto/report-changes";
import { SiteMap } from "@/components/proto/site-map";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  LANDCOVER,
  LANDCOVER_ORDER,
  SERVICE_GROUPS,
  type LatLng,
} from "@/lib/site-data";
import { date, money, reportQuarter, signed } from "@/lib/format";
import type { ReportFacts, SummarySource } from "@/lib/report-facts";

export function Panel({
  title,
  action,
  children,
  className,
  headingLevel: Heading = "h3",
  ...rest
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** `h2` when the panel is a top-level section of its page. */
  headingLevel?: "h2" | "h3";
} & React.HTMLAttributes<HTMLElement>) {
  const headingId = useId();
  return (
    <section
      // A page's own sections are named landmarks; panels nested inside them aren't.
      aria-labelledby={Heading === "h2" ? headingId : undefined}
      className={cn("rounded-3xl bg-card p-6 shadow-soft", className)}
      {...rest}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Heading id={headingId} className="text-base font-semibold">
          {title}
        </Heading>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ServicesPanel({
  facts,
  headingLevel,
}: {
  facts: ReportFacts;
  headingLevel?: "h2" | "h3";
}) {
  // A group is shown only when the report values every one of its parts.
  const groups = SERVICE_GROUPS.flatMap((g) => {
    const parts = g.parts.map((k) => facts.services[k]);
    return parts.every((v) => v !== undefined)
      ? [{ ...g, value: parts.reduce<number>((sum, v) => sum + v!, 0) }]
      : [];
  }).sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...groups.map((g) => g.value));
  return (
    <Panel title="What the land does each year" headingLevel={headingLevel}>
      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          The service breakdown isn&apos;t available for this report.
        </p>
      )}
      <ul className="space-y-3">
        {groups.map((g) => (
          <li key={g.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span>{g.label}</span>
              <span className="tabular text-muted-foreground">
                {money(g.value, { compact: true })}
              </span>
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-foreground/6">
              <div
                className="h-full rounded-full bg-lime"
                style={{ width: `${(g.value / max) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-5 grid grid-cols-2 gap-4 border-t pt-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Carbon stored</div>
          <div className="tabular text-xl font-light">
            {facts.carbonStock === null
              ? "—"
              : `${facts.carbonStock.toLocaleString("en-US")} tCO₂`}
          </div>
          <div className="text-xs text-muted-foreground">
            Shown separately, not in the $ value
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Mid estimate</div>
          <div className="tabular text-xl font-light">
            {facts.valueMid === null ? "—" : `${money(facts.valueMid)} /yr`}
          </div>
          <div className="text-xs text-muted-foreground">
            Int$ at 2020 prices
          </div>
        </div>
      </div>
    </Panel>
  );
}

function landcoverClasses(landcover: ReportFacts["landcover"]) {
  const known = LANDCOVER_ORDER.filter((k) => (landcover[k] ?? 0) > 0.001).map(
    (k) => ({ key: k, share: landcover[k]!, ...LANDCOVER[k] }),
  );
  const other = Object.entries(landcover)
    .filter(
      ([k, v]) =>
        !(LANDCOVER_ORDER as string[]).includes(k) && (v ?? 0) > 0.001,
    )
    .map(([k, v]) => ({
      key: k,
      share: v!,
      label: k[0]!.toUpperCase() + k.slice(1).replaceAll("_", " "),
      color: "#b39fe1",
    }));
  return [...known, ...other];
}

export function LandcoverBar({
  landcover,
}: {
  landcover: ReportFacts["landcover"];
}) {
  const classes = landcoverClasses(landcover);
  return (
    <div>
      <div
        className="flex h-4 overflow-hidden rounded-full"
        role="img"
        aria-label={`Land cover composition: ${classes
          .map((c) => `${c.label} ${(c.share * 100).toFixed(1)}%`)
          .join(", ")}`}
      >
        {classes.map((c) => (
          <div
            key={c.key}
            style={{ width: `${c.share * 100}%`, background: c.color }}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        {classes.map((c) => (
          <li key={c.key} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: c.color }}
              aria-hidden="true"
            />
            <span className="truncate">{c.label}</span>
            <span className="tabular ml-auto text-muted-foreground">
              {(c.share * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandPanel({
  polygon,
  label,
  overlay,
  landcover,
  simulated = false,
  caption,
}: {
  polygon: LatLng[];
  label: string;
  /** The Dynamic World overlay image and its bounds; null while unavailable. */
  overlay: { url: string; bounds: [LatLng, LatLng] } | null;
  landcover: ReportFacts["landcover"];
  simulated?: boolean;
  caption?: React.ReactNode;
}) {
  return (
    <Panel title="Land cover">
      <LandCoverView
        polygon={polygon}
        label={label}
        overlay={overlay}
        landcover={landcover}
        simulated={simulated}
        caption={caption}
      />
    </Panel>
  );
}

/** The land-cover map with its overlay switch and composition bar, inside a panel. */
export function LandCoverView({
  polygon,
  label,
  overlay,
  landcover,
  simulated = false,
  caption,
}: Parameters<typeof LandPanel>[0]) {
  const [visible, setVisible] = useState(true);
  return (
    <>
      {overlay && (
        <label className="mb-3 flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <Layers className="size-4" aria-hidden="true" />
          Dynamic World overlay
          <Switch checked={visible} onCheckedChange={setVisible} />
        </label>
      )}
      {polygon.length > 2 ? (
        <SiteMap
          polygon={polygon}
          label={label}
          overlay={overlay ? { ...overlay, visible } : undefined}
        />
      ) : (
        <p className="rounded-2xl bg-secondary p-6 text-center text-sm text-muted-foreground">
          No boundary to map for this site.
        </p>
      )}
      <div className="mt-5">
        <LandcoverBar landcover={landcover} />
      </div>
      {simulated && (
        <p className="mt-3 text-xs text-muted-foreground">
          The map shows the latest real imagery; the composition above includes
          this quarter&apos;s simulated change.
        </p>
      )}
      {caption && (
        <div className="mt-3 text-xs text-muted-foreground">{caption}</div>
      )}
    </>
  );
}

export function ScorePanel({ facts }: { facts: ReportFacts }) {
  return (
    <Panel title="How the score is built">
      <ul className="space-y-3">
        {facts.components.map((s) => (
          <li key={s.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span>
                {s.label}{" "}
                <span className="text-muted-foreground">
                  · weight {Math.round(s.weight * 100)}%
                </span>
              </span>
              <span className="tabular text-muted-foreground">
                {(s.value * 100).toFixed(0)} / 100
              </span>
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-foreground/6">
              <div
                className={cn(
                  "h-full rounded-full",
                  s.value < 0.5 ? "bg-clay" : "bg-grade-aa",
                )}
                style={{ width: `${s.value * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-5 rounded-2xl bg-secondary p-4 text-sm">
        {facts.baseHealth !== null && (
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span>Formula health</span>
            <span className="tabular">{facts.baseHealth.toFixed(1)}</span>
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
          <span>Auditor adjustment (±10 max)</span>
          <span
            className={cn(
              "tabular",
              (facts.adjustment ?? 0) < 0 && "text-clay-ink",
            )}
          >
            {facts.adjustment === null ? "—" : signed(facts.adjustment)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2 font-medium">
          <span>Health</span>
          <span className="tabular">{facts.health.toFixed(1)}</span>
        </div>
        {facts.adjustmentReason && (
          <p className="mt-2 text-xs text-muted-foreground">
            {facts.adjustmentReason}
          </p>
        )}
      </div>
      <div className="mt-5">
        <div className="text-sm font-medium">
          Confidence {facts.confidence.toFixed(0)}%
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {facts.confidenceParts.map((c) => (
            <div key={c.key} className="rounded-2xl border px-3 py-2">
              <dt className="text-xs text-muted-foreground">
                {c.label} · {Math.round(c.weight * 100)}%
              </dt>
              <dd className="tabular text-lg font-light">
                {Math.round(c.value * 100)}%
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}

const SUMMARY_SOURCE: Record<SummarySource, string> = {
  auditor: "Written by the Auditor (Nemotron), with cited facts",
  live: "Written by Nemotron from this report's numbers",
  fallback: "Template summary from this report's numbers (no AI)",
};

/** Report versions, newest first; the picker shows any version and what changed from the one before (the diff API). */
export function ReportTab({
  versions,
  siteName,
  initialVersion = null,
}: {
  versions: ReportFacts[];
  /** The seal and its share card always carry the site's name. */
  siteName: string;
  /** The version a shared link asked for (`?version=`), until another one is picked. */
  initialVersion?: number | null;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const index = Math.max(
    0,
    versions.findIndex((r) =>
      picked ? r.id === picked : r.version === initialVersion,
    ),
  );
  const report = versions[index];
  if (!report) return null;
  // Versions are newest first: the previous report is the next item, whatever its number.
  const prev = versions[index + 1];
  const quarter = reportQuarter(report.period, report.createdAt);
  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <Panel
        title={`Proof of Life · ${quarter}`}
        action={
          <Select value={report.id} onValueChange={setPicked}>
            <SelectTrigger className="w-52" aria-label="Proof of Life version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  v{r.version}
                  {" · "}
                  {reportQuarter(r.period, r.createdAt)} · {r.grade}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <ProofOfLifeSeal
            key={report.id}
            health={report.health}
            grade={report.grade}
            quarter={quarter}
            siteName={siteName}
            size={168}
            rise
          />
          <div className="min-w-0 space-y-3">
            <p className="font-mono text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
              Ecological Performance Report · v{report.version}
            </p>
            <GradeBadge
              grade={report.grade}
              health={report.health}
              showLabel
              size="lg"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Issued {date(report.createdAt)}
              </span>
              {report.simulated && (
                <span className="rounded-full bg-lilac/30 px-2.5 py-0.5 text-xs font-medium">
                  Simulated scenario
                </span>
              )}
            </div>
          </div>
        </div>
        <MarkdownText
          text={report.summary}
          className="mt-4 max-w-prose space-y-3 text-[15px] leading-relaxed"
        />
        <p className="mt-3 text-xs text-muted-foreground">
          {SUMMARY_SOURCE[report.summarySource]}
        </p>
        {report.flags.length > 0 && (
          <div className="mt-5">
            <h4 className="text-sm font-medium">Data and method flags</h4>
            <ul className="mt-2 space-y-1.5">
              {report.flags.map((f, i) => (
                <li
                  key={`${f.code}-${i}`}
                  className="flex gap-2 text-sm text-muted-foreground"
                >
                  <Flag
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {f.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.citations.length > 0 && (
          <div className="mt-5">
            <h4 className="text-sm font-medium">
              Auditor cited
              {report.citationsNote ? ` (${report.citationsNote})` : ""}
            </h4>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {report.citations.map((c) => (
                <span
                  key={c}
                  className="rounded-full bg-secondary px-2.5 py-1 font-mono text-[11px]"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}
      </Panel>
      <div className="space-y-6">
        <ProofOfLifeShareCard
          version={report.version}
          siteName={siteName}
          health={report.health}
          grade={report.grade}
          quarter={quarter}
          simulated={report.simulated}
        />
        <Panel
          title={prev ? `What changed since v${prev.version}` : "What changed"}
        >
          {!prev ? (
            <p className="text-sm text-muted-foreground">
              This is the first rating, so there&apos;s nothing to compare yet.
            </p>
          ) : (
            <ReportChanges
              key={`${report.id}:${prev.id}`}
              reportId={report.id}
              prevId={prev.id}
            />
          )}
        </Panel>
        <Panel title="Recovery plan">
          {report.recommendations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recovery steps were recommended in this Proof of Life.
            </p>
          ) : (
            <ul className="space-y-2.5 text-sm">
              {report.recommendations.map((r, i) => (
                <li key={`${i}-${r}`} className="flex gap-2.5">
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-lime-ink"
                    aria-hidden="true"
                  />
                  {r}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

export type NewsItem = {
  id: string;
  title: string;
  summary: string | null;
  date: string;
  direction: number | null;
  severity: number | null;
  kind: string | null;
  sourceLabel: string;
  url?: string | null;
  /** Illustrative prototype content, tagged "Sample". */
  sample?: boolean;
};
