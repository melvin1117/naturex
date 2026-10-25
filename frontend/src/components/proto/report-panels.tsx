"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleSlash,
  ExternalLink,
  Flag,
  Layers,
} from "lucide-react";
import { useId, useState } from "react";

import { safeHref } from "@/lib/safe-href";
import { cn } from "cn";

import {
  ProofOfLifeSeal,
  ProofOfLifeShareCard,
} from "@/components/brand/proof-of-life";
import { MarkdownText } from "@/components/markdown-text";
import { SampleTag } from "@/components/proto/bits";
import { NdviChart } from "@/components/proto/charts";
import { GradeBadge } from "@/components/proto/grade";
import { ReportChanges } from "@/components/proto/report-changes";
import { SiteMap } from "@/components/proto/site-map";
import { VerificationBadge } from "@/components/proto/verification";
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
} from "@/lib/prototype/data";
import {
  date,
  price as fmtPrice,
  money,
  reportQuarter,
  signed,
} from "@/lib/prototype/format";
import { documentChecks, type Site } from "@/lib/prototype/world";
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

export function TrendPanel({ facts }: { facts: ReportFacts }) {
  const label = facts.trendLabel;
  return (
    <Panel
      title="Vegetation over five years"
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
        <NdviChart series={facts.ndvi} />
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No monthly NDVI series is stored with this report.
        </p>
      )}
      {facts.ndviTrend !== null && (
        <p className="mt-3 text-xs text-muted-foreground">
          Monthly Sentinel-2 NDVI, cloud-masked. Trend{" "}
          {facts.ndviTrend >= 0 ? "+" : ""}
          {facts.ndviTrend.toFixed(4)} a year (Sen&apos;s slope
          {facts.ndviP !== null &&
            `, Mann–Kendall p ${facts.ndviP < 0.01 ? "< 0.01" : `= ${facts.ndviP.toFixed(2)}`}`}
          ).
        </p>
      )}
    </Panel>
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
          <span>
            Auditor adjustment (±10 max)
            {facts.adjustmentNote && (
              <span className="text-muted-foreground">
                {" "}
                · {facts.adjustmentNote}
              </span>
            )}
          </span>
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
  scripted: "Scripted in this prototype",
};

type DiffRow = [
  string,
  number | null,
  number | null | undefined,
  (v: number) => string,
];

/** The prototype has no diff API: it compares its own report facts in the browser. */
function prototypeDiffRows(report: ReportFacts, prev?: ReportFacts): DiffRow[] {
  return [
    ["Health", report.health, prev?.health, (v) => v.toFixed(1)],
    [
      "Confidence",
      report.confidence,
      prev?.confidence,
      (v) => `${v.toFixed(0)}%`,
    ],
    ["Value (mid, /yr)", report.valueMid, prev?.valueMid, (v) => money(v)],
    [
      "Built-up land",
      report.builtShare === null ? null : report.builtShare * 100,
      prev && prev.builtShare !== null ? prev.builtShare * 100 : undefined,
      (v) => `${v.toFixed(1)}%`,
    ],
    [
      "Water change",
      report.waterChange,
      prev?.waterChange,
      (v) => v.toFixed(1),
    ],
    ["NDVI trend /yr", report.ndviTrend, prev?.ndviTrend, (v) => v.toFixed(4)],
    [
      "Fair price per unit",
      report.fairValuePerUnit,
      prev?.fairValuePerUnit,
      (v) => fmtPrice(v),
    ],
  ];
}

/** Report versions, newest first; the picker shows any version and what changed from the one before. */
export function ReportTab({
  versions,
  siteName,
  initialVersion = null,
  live = false,
}: {
  versions: ReportFacts[];
  /** The seal and its share card always carry the site's name. */
  siteName: string;
  /** The version a shared link asked for (`?version=`), until another one is picked. */
  initialVersion?: number | null;
  /**
   * A real asset: the changes, grade change and reasons come from the diff API. The prototype
   * (false) has no API and compares its own report facts in the browser.
   */
  live?: boolean;
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
          ) : live ? (
            <ReportChanges
              key={`${report.id}:${prev.id}`}
              reportId={report.id}
              prevId={prev.id}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Metric</th>
                  <th className="pb-2 text-right font-medium">
                    v{prev.version}
                  </th>
                  <th className="pb-2 text-right font-medium">
                    v{report.version}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {prototypeDiffRows(report, prev).map(
                  ([label, now, before, f]) => {
                    const diff =
                      now === null || before === null || before === undefined
                        ? 0
                        : now - before;
                    return (
                      <tr key={label}>
                        <td className="py-2">{label}</td>
                        <td className="tabular py-2 text-right text-muted-foreground">
                          {before === null || before === undefined
                            ? "—"
                            : f(before)}
                        </td>
                        <td className="tabular py-2 text-right">
                          <span className="inline-flex items-center gap-1">
                            {Math.abs(diff) > 1e-6 &&
                              (diff > 0 ? (
                                <ArrowUpRight
                                  className="size-3.5 text-muted-foreground"
                                  aria-label="up"
                                />
                              ) : (
                                <ArrowDownRight
                                  className="size-3.5 text-muted-foreground"
                                  aria-label="down"
                                />
                              ))}
                            {now === null ? "—" : f(now)}
                          </span>
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
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

export function NewsList({
  events,
  empty,
}: {
  events: NewsItem[];
  empty?: string;
}) {
  if (events.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {empty ?? "No events found near this site yet."}
      </p>
    );
  return (
    <ul className="divide-y">
      {events.map((e) => {
        const href = safeHref(e.url);
        const negative = (e.direction ?? 0) < 0;
        return (
          <li key={e.id} className="flex gap-4 py-4 first:pt-0 last:pb-0">
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-2xl",
                negative
                  ? "bg-clay/15 text-clay-ink"
                  : "bg-lime/30 text-lime-ink",
              )}
              aria-hidden="true"
            >
              {negative ? (
                <ArrowDownRight className="size-4" />
              ) : (
                <ArrowUpRight className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-words">{e.title}</span>
                {e.sample && <SampleTag />}
              </div>
              {e.summary && (
                <p className="mt-1 text-sm break-words text-muted-foreground">
                  {e.summary}
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{date(e.date)}</span>
                {e.kind && (
                  <span className="capitalize">
                    {e.kind.replaceAll("_", " ")}
                  </span>
                )}
                <span>
                  {negative
                    ? "Negative"
                    : (e.direction ?? 0) > 0
                      ? "Positive"
                      : "Neutral"}
                  {e.severity !== null && ` · severity ${e.severity} of 5`}
                </span>
                <span>{e.sourceLabel}</span>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
                  >
                    Source
                    <ExternalLink className="size-3" aria-hidden="true" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const CHECKS: {
  key: keyof ReturnType<typeof documentChecks>;
  name: string;
  note: string;
}[] = [
  {
    key: "format",
    name: "Accepted file format",
    note: "PDF, JPEG or PNG under 5 MB; malformed files rejected",
  },
  {
    key: "not_reused",
    name: "Not reused",
    note: "The same document can't back two listings",
  },
  {
    key: "boundary_free",
    name: "Boundary is free",
    note: "No overlap with another listing",
  },
  {
    key: "consent_document",
    name: "Consent-labelled document attached",
    note: "Shows a document labelled as consent was attached, not that consent exists",
  },
];

const RESULT_TEXT = { pass: "Pass", fail: "Fail", not_run: "Not run" } as const;

const NOT_CHECKED =
  "Whether documents are authentic; whether the issuing authority is real and the title current; legal validity and signatures; quorum and validity of community consent (FPIC); whether the drawn boundary matches the legal parcel; who the uploader really is.";

export function VerificationTab({ site }: { site: Site }) {
  const checks = documentChecks(site.documents);
  return (
    <Panel title="How this listing was verified">
      <div className="flex flex-wrap items-center gap-3">
        <VerificationBadge level={site.verification} />
        {site.verifiedAt && site.verification === "verified" && (
          <span className="text-sm text-muted-foreground">
            {date(site.verifiedAt)} · reviewer role: platform admin
          </span>
        )}
      </div>
      {site.documents.length > 0 && (
        <p className="mt-4 rounded-2xl bg-secondary p-4 text-sm font-medium">
          Demo verification: sample documents, no real ownership checked.
        </p>
      )}
      <ul className="mt-5 divide-y">
        {CHECKS.map(({ key, name, note }) => {
          const result = checks[key] as keyof typeof RESULT_TEXT;
          return (
            <li key={key} className="flex items-start gap-3 py-3">
              <span
                className={cn(
                  "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full",
                  result === "pass"
                    ? "bg-lime/30 text-lime-ink"
                    : result === "fail"
                      ? "bg-clay/15 text-clay-ink"
                      : "bg-secondary text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {result === "pass" ? (
                  <Check className="size-3.5" />
                ) : result === "fail" ? (
                  <AlertTriangle className="size-3.5" />
                ) : (
                  <CircleSlash className="size-3.5" />
                )}
              </span>
              <div>
                <div className="text-sm font-medium">{name}</div>
                <div className="text-xs text-muted-foreground">{note}</div>
              </div>
              <span className="ml-auto text-xs text-muted-foreground">
                {RESULT_TEXT[result]}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 rounded-2xl bg-secondary p-4 text-sm">
        <div className="font-medium">Not checked</div>
        <p className="mt-1 text-muted-foreground">{NOT_CHECKED}</p>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        The badge never says &ldquo;ownership proven&rdquo;. Each review
        decision is written to the Record without names or documents (ADR-0006).
      </p>
    </Panel>
  );
}
