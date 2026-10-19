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
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { MarkdownText } from "@/components/markdown-text";
import { SampleTag } from "@/components/proto/bits";
import { NdviChart } from "@/components/proto/charts";
import { GradeBadge } from "@/components/proto/grade";
import { SiteMap } from "@/components/proto/site-map";
import { VerificationBadge } from "@/components/proto/verification";
import { Button } from "@/components/ui/button";
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
import { date, money, quarterLabel, signed } from "@/lib/prototype/format";
import { verify, type VerifyResult } from "@/lib/prototype/ledger";
import { usePrototype } from "@/lib/prototype/store";
import { documentChecks, tamperLedger, type Site } from "@/lib/prototype/world";
import type { ReportFacts, SummarySource } from "@/lib/report-facts";

export function Panel({
  title,
  action,
  children,
  className,
  ...rest
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("rounded-3xl bg-card p-6 shadow-soft", className)}
      {...rest}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ServicesPanel({ facts }: { facts: ReportFacts }) {
  // A group is shown only when the report values every one of its parts.
  const groups = SERVICE_GROUPS.flatMap((g) => {
    const parts = g.parts.map((k) => facts.services[k]);
    return parts.every((v) => v !== undefined)
      ? [{ ...g, value: parts.reduce<number>((sum, v) => sum + v!, 0) }]
      : [];
  }).sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...groups.map((g) => g.value));
  return (
    <Panel title="What the land does each year">
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
  const [visible, setVisible] = useState(true);
  return (
    <Panel
      title="Land cover"
      action={
        overlay && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Layers className="size-4" aria-hidden="true" />
            Dynamic World overlay
            <Switch checked={visible} onCheckedChange={setVisible} />
          </label>
        )
      }
    >
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
    </Panel>
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
            `, Mann–Kendall p = ${facts.ndviP.toFixed(2)}`}
          ). Dashed line is a visual guide.
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

function diffRows(report: ReportFacts, prev?: ReportFacts): DiffRow[] {
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
      (v) => `$${v.toFixed(2)}`,
    ],
  ];
}

/** Report versions, newest first; the picker shows any version and what changed from the one before. */
export function ReportTab({ versions }: { versions: ReportFacts[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const report = versions.find((r) => r.id === picked) ?? versions[0];
  if (!report) return null;
  const prev = versions.find((r) => r.version === report.version - 1);
  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <Panel
        title={`Ecological Performance Report · v${report.version}`}
        action={
          <Select value={report.id} onValueChange={setPicked}>
            <SelectTrigger className="w-52" aria-label="Report version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  v{r.version}
                  {r.period ? ` · ${quarterLabel(r.period)}` : ""} · {r.grade}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <GradeBadge
            grade={report.grade}
            health={report.health}
            showLabel
            size="lg"
          />
          <span className="text-sm text-muted-foreground">
            Issued {date(report.createdAt)}
          </span>
          {report.simulated && (
            <span className="rounded-full bg-lilac/30 px-2.5 py-0.5 text-xs font-medium">
              Simulated scenario
            </span>
          )}
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
        <Panel
          title={prev ? `What changed since v${prev.version}` : "What changed"}
        >
          {!prev ? (
            <p className="text-sm text-muted-foreground">
              This is the first rating, so there&apos;s nothing to compare yet.
            </p>
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
                {diffRows(report, prev).map(([label, now, before, f]) => {
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
                })}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Stewardship actions">
          {report.recommendations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No actions were recommended in this report.
            </p>
          ) : (
            <ul className="space-y-2.5 text-sm">
              {report.recommendations.map((r) => (
                <li key={r} className="flex gap-2.5">
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

function safeHref(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

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

export type LedgerRow = {
  seq: number;
  kind: string;
  date: string;
  hash: string;
  payload: Record<string, unknown>;
};

export type LedgerCheck = {
  valid: boolean;
  entries: number;
  brokenAt: number | null;
  /** Where the hashes were recomputed, or why the chain can't be trusted. */
  note: string;
};

function payloadText(payload: Record<string, unknown>) {
  return Object.entries(payload)
    .map(
      ([k, v]) =>
        `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`,
    )
    .join(" · ");
}

/** The Nature Ledger: entries newest first, the verify result and the caller's actions. */
export function LedgerPanel({
  entries,
  check,
  actions,
  tamperedAt,
  empty = "No ledger entries yet.",
}: {
  entries: LedgerRow[];
  check: LedgerCheck | null;
  actions: React.ReactNode;
  tamperedAt?: number;
  empty?: string;
}) {
  return (
    <section className="rounded-3xl bg-machine p-6 text-machine-ink shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h3 className="font-serif text-3xl">Nature Ledger</h3>
          <p className="mt-1 text-sm text-machine-muted">
            Append-only and hash-chained. Each entry stores sha256 of its
            content, kind, sequence number and the previous entry&apos;s hash,
            so changing any old entry breaks every link after it. No tokens, no
            trading: it&apos;s a public record.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
      <div aria-live="polite">
        {check && (
          <div
            role="status"
            className={cn(
              "nx-rise mt-5 flex items-start gap-3 rounded-2xl p-4",
              check.valid ? "bg-lime/15" : "bg-clay/25",
            )}
          >
            {check.valid ? (
              <ShieldCheck
                className="mt-0.5 size-5 text-lime"
                aria-hidden="true"
              />
            ) : (
              <ShieldX className="mt-0.5 size-5 text-clay" aria-hidden="true" />
            )}
            <div className="text-sm">
              <div className="font-medium">
                {check.valid
                  ? check.entries === 1
                    ? "Chain intact: its 1 entry verified."
                    : `Chain intact: all ${check.entries} entries verified.`
                  : check.brokenAt !== null
                    ? `Tampering detected at entry #${check.brokenAt}.`
                    : "The chain doesn't verify."}
              </div>
              <div className="text-machine-muted">{check.note}</div>
            </div>
          </div>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="mt-5 text-sm text-machine-muted">{empty}</p>
      ) : (
        <ol className="mt-5 space-y-2">
          {[...entries].reverse().map((e) => (
            <li
              key={e.seq}
              className={cn(
                "rounded-2xl bg-machine-raised px-4 py-3",
                tamperedAt === e.seq && "ring-2 ring-clay",
              )}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="tabular font-mono text-xs text-machine-muted">
                  #{e.seq}
                </span>
                <span className="font-medium capitalize">
                  {e.kind.replaceAll("_", " ")}
                </span>
                <span className="text-xs text-machine-muted">
                  {date(e.date)}
                </span>
                {tamperedAt === e.seq && (
                  <span className="rounded-full bg-clay px-2 py-0.5 text-[11px] font-semibold text-white">
                    Edited
                  </span>
                )}
                <span
                  className="ml-auto font-mono text-[11px] text-machine-muted"
                  title={e.hash}
                >
                  {e.hash.slice(0, 10)}…{e.hash.slice(-6)}
                </span>
              </div>
              <div className="mt-1.5 font-mono text-[11px] break-all text-machine-muted">
                {payloadText(e.payload)}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export const LEDGER_PRIMARY = "bg-lime text-machine hover:bg-lime/90";
export const LEDGER_OUTLINE =
  "border-machine-line bg-transparent text-machine-ink hover:bg-machine-raised hover:text-machine-ink";

function prototypeCheck(result: VerifyResult): LedgerCheck {
  return result.valid
    ? {
        valid: true,
        entries: result.entries,
        brokenAt: null,
        note: "Every hash was recomputed in your browser and matches.",
      }
    : {
        valid: false,
        entries: result.entries,
        brokenAt: result.brokenAt,
        note: `${result.reason} This entry and every entry after it can't be trusted.`,
      };
}

/** The prototype's ledger, verified in the browser, with the tamper demo. */
export function LedgerTab({ site }: { site: Site }) {
  const { world, act } = usePrototype();
  const chain = world.ledger[site.id] ?? [];
  const [result, setResult] = useState<VerifyResult | null>(null);
  const tamperedAt = world.tampered[site.id];
  return (
    <div className="space-y-6">
      <LedgerPanel
        entries={chain}
        check={result && prototypeCheck(result)}
        tamperedAt={tamperedAt}
        actions={
          <>
            <Button
              className={LEDGER_PRIMARY}
              onClick={() => setResult(verify(chain))}
              data-tour="ledger-verify"
            >
              <ShieldCheck aria-hidden="true" />
              Verify chain
            </Button>
            <Button
              variant="outline"
              className={LEDGER_OUTLINE}
              onClick={() => {
                act((w) => tamperLedger(w, site.id));
                setResult(null);
              }}
              disabled={tamperedAt !== undefined}
              data-tour="ledger-tamper"
            >
              <AlertTriangle aria-hidden="true" />
              Tamper demo
            </Button>
          </>
        }
      />
    </div>
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
        decision is written to the Nature Ledger without names or documents
        (ADR-0006).
      </p>
    </Panel>
  );
}
