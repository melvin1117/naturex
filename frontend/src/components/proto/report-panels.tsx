"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleSlash,
  Flag,
  Layers,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

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
  SCORE_COMPONENTS,
  SERVICE_GROUPS,
  siteDataFor,
} from "@/lib/prototype/data";
import { date, money, quarterLabel, signed } from "@/lib/prototype/format";
import { verify, type VerifyResult } from "@/lib/prototype/ledger";
import type { Report } from "@/lib/prototype/rating";
import { usePrototype } from "@/lib/prototype/store";
import { tamperLedger, type NewsEvent, type Site } from "@/lib/prototype/world";

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

export function ServicesPanel({ report }: { report: Report }) {
  const groups = SERVICE_GROUPS.map((g) => ({
    ...g,
    value: g.parts.reduce((sum, k) => sum + report.services[k], 0),
  })).sort((a, b) => b.value - a.value);
  const max = Math.max(...groups.map((g) => g.value));
  return (
    <Panel title="What the land does each year">
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
            {report.carbon.stock.toLocaleString("en-US")} tCO₂
          </div>
          <div className="text-xs text-muted-foreground">
            Shown separately, not in the $ value
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Mid estimate</div>
          <div className="tabular text-xl font-light">
            {money(report.valueMid)} /yr
          </div>
          <div className="text-xs text-muted-foreground">
            Int$ at 2020 prices
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function LandcoverBar({
  landcover,
}: {
  landcover: Report["landcover"];
}) {
  return (
    <div>
      <div
        className="flex h-4 overflow-hidden rounded-full"
        role="img"
        aria-label="Land cover composition"
      >
        {LANDCOVER_ORDER.filter((k) => landcover[k] > 0.001).map((k) => (
          <div
            key={k}
            style={{
              width: `${landcover[k] * 100}%`,
              background: LANDCOVER[k].color,
            }}
            title={`${LANDCOVER[k].label} ${(landcover[k] * 100).toFixed(1)}%`}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        {LANDCOVER_ORDER.filter((k) => landcover[k] > 0.001).map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: LANDCOVER[k].color }}
              aria-hidden="true"
            />
            <span className="truncate">{LANDCOVER[k].label}</span>
            <span className="tabular ml-auto text-muted-foreground">
              {(landcover[k] * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandPanel({ site, report }: { site: Site; report: Report }) {
  const [overlay, setOverlay] = useState(true);
  const data = siteDataFor(site.key);
  return (
    <Panel
      title="Land cover"
      action={
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Layers className="size-4" aria-hidden="true" />
          Dynamic World overlay
          <Switch checked={overlay} onCheckedChange={setOverlay} />
        </label>
      }
    >
      <SiteMap
        polygon={site.polygon}
        label={site.name}
        overlay={{
          url: `/demo-sites/${site.key}.overlay.png`,
          bounds: data.overlayBounds,
          visible: overlay,
        }}
      />
      <div className="mt-5">
        <LandcoverBar landcover={report.landcover} />
      </div>
      {report.scenario !== "baseline" && (
        <p className="mt-3 text-xs text-muted-foreground">
          The map shows the latest real imagery; the composition above includes
          this quarter&apos;s simulated change.
        </p>
      )}
    </Panel>
  );
}

export function TrendPanel({ report }: { report: Report }) {
  const label =
    report.ndviTrend > 0.005
      ? "Improving"
      : report.ndviTrend < -0.005
        ? "Declining"
        : "Stable";
  return (
    <Panel
      title="Vegetation over five years"
      action={
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
      }
    >
      <NdviChart series={report.ndvi} />
      <p className="mt-3 text-xs text-muted-foreground">
        Monthly Sentinel-2 NDVI, cloud-masked. Trend{" "}
        {report.ndviTrend >= 0 ? "+" : ""}
        {report.ndviTrend.toFixed(4)} a year (Sen&apos;s slope, Mann–Kendall p ={" "}
        {report.ndviP.toFixed(2)}). Dashed line is a visual guide.
      </p>
    </Panel>
  );
}

export function ScorePanel({ report }: { report: Report }) {
  const c = report.confidenceComponents;
  return (
    <Panel title="How the score is built">
      <ul className="space-y-3">
        {SCORE_COMPONENTS.map((s) => {
          const v = report.components[s.key] ?? 0;
          return (
            <li key={s.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  {s.label}{" "}
                  <span className="text-muted-foreground">
                    · weight {Math.round(s.weight * 100)}%
                  </span>
                </span>
                <span className="tabular text-muted-foreground">
                  {(v * 100).toFixed(0)} / 100
                </span>
              </div>
              <div className="mt-1.5 h-2 rounded-full bg-foreground/6">
                <div
                  className={cn(
                    "h-full rounded-full",
                    v < 0.5 ? "bg-clay" : "bg-grade-aa",
                  )}
                  style={{ width: `${v * 100}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-5 rounded-2xl bg-secondary p-4 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span>Formula health</span>
          <span className="tabular">{report.baseHealth.toFixed(1)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
          <span>Auditor adjustment (±10 max)</span>
          <span
            className={cn("tabular", report.adjustment < 0 && "text-clay-ink")}
          >
            {signed(report.adjustment)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2 font-medium">
          <span>Health</span>
          <span className="tabular">{report.health.toFixed(1)}</span>
        </div>
        {report.adjustmentReason && (
          <p className="mt-2 text-xs text-muted-foreground">
            {report.adjustmentReason}
          </p>
        )}
      </div>
      <div className="mt-5">
        <div className="text-sm font-medium">
          Confidence {report.confidence.toFixed(0)}%
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {[
            ["Coverage", c.coverage, "40%"],
            ["Agreement", c.agreement, "30%"],
            ["Evidence", c.evidence, "20%"],
            ["Recency", c.recency, "10%"],
          ].map(([k, v, w]) => (
            <div key={k as string} className="rounded-2xl border px-3 py-2">
              <dt className="text-xs text-muted-foreground">
                {k as string} · {w as string}
              </dt>
              <dd className="tabular text-lg font-light">
                {Math.round((v as number) * 100)}%
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}

function renderSummary(text: string) {
  return text.split("\n\n").map((para, i) => (
    <p key={i}>
      {para.split(/(\*\*[^*]+\*\*)/).map((part, j) =>
        part.startsWith("**") ? (
          <strong key={j} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={j}>{part}</span>
        ),
      )}
    </p>
  ));
}

export function ReportTab({ site }: { site: Site }) {
  const versions = [...site.reports].reverse();
  const [picked, setPicked] = useState<number | null>(null);
  const report = versions.find((r) => r.version === picked) ?? versions[0];
  const prev = site.reports.find((r) => r.version === report.version - 1);
  const rows: [string, number, number | undefined, (v: number) => string][] = [
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
      report.landcover.built * 100,
      prev ? prev.landcover.built * 100 : undefined,
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
  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <Panel
        title={`Ecological Performance Report · v${report.version}`}
        action={
          <Select
            value={String(report.version)}
            onValueChange={(v) => setPicked(Number(v))}
          >
            <SelectTrigger className="w-52" aria-label="Report version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((r) => (
                <SelectItem key={r.version} value={String(r.version)}>
                  v{r.version} · {quarterLabel(r.period)} · {r.grade}
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
        </div>
        <div className="mt-4 max-w-prose space-y-3 text-[15px] leading-relaxed">
          {renderSummary(report.summary)}
        </div>
        {report.flags.length > 0 && (
          <div className="mt-5">
            <h4 className="text-sm font-medium">Data and method flags</h4>
            <ul className="mt-2 space-y-1.5">
              {report.flags.map((f) => (
                <li
                  key={f.code}
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
            <h4 className="text-sm font-medium">Auditor cited</h4>
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
                {rows.map(([label, now, before, f]) => {
                  const diff = before === undefined ? 0 : now - before;
                  return (
                    <tr key={label}>
                      <td className="py-2">{label}</td>
                      <td className="tabular py-2 text-right text-muted-foreground">
                        {before === undefined ? "—" : f(before)}
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
                          {f(now)}
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
        </Panel>
      </div>
    </div>
  );
}

export function NewsList({
  events,
  empty,
}: {
  events: NewsEvent[];
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
      {[...events].reverse().map((e) => (
        <li key={e.id} className="flex gap-4 py-4 first:pt-0 last:pb-0">
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-2xl",
              e.direction < 0
                ? "bg-clay/15 text-clay-ink"
                : "bg-lime/30 text-lime-ink",
            )}
            aria-hidden="true"
          >
            {e.direction < 0 ? (
              <ArrowDownRight className="size-4" />
            ) : (
              <ArrowUpRight className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{e.title}</span>
              <SampleTag />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{e.summary}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{date(e.date)}</span>
              <span className="capitalize">{e.kind}</span>
              <span>
                {e.direction < 0
                  ? "Negative"
                  : e.direction > 0
                    ? "Positive"
                    : "Neutral"}{" "}
                · severity {e.severity} of 5
              </span>
              <span>
                {e.source === "time_machine"
                  ? "Injected by Time Machine"
                  : "Found by News Scout"}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LedgerTab({ site }: { site: Site }) {
  const { world, act } = usePrototype();
  const chain = world.ledger[site.id] ?? [];
  const [result, setResult] = useState<VerifyResult | null>(null);
  const tamperedAt = world.tampered[site.id];
  return (
    <div className="space-y-6">
      <section className="rounded-3xl bg-machine p-6 text-machine-ink shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h3 className="font-serif text-3xl">Nature Ledger</h3>
            <p className="mt-1 text-sm text-machine-muted">
              Append-only and hash-chained. Each entry stores sha256 of its
              content, kind, sequence number and the previous entry&apos;s hash,
              so changing any old entry breaks every link after it. No tokens,
              no trading: it&apos;s a public record.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              className="bg-lime text-machine hover:bg-lime/90"
              onClick={() => setResult(verify(chain))}
              data-tour="ledger-verify"
            >
              <ShieldCheck aria-hidden="true" />
              Verify chain
            </Button>
            <Button
              variant="outline"
              className="border-machine-line bg-transparent text-machine-ink hover:bg-machine-raised hover:text-machine-ink"
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
          </div>
        </div>
        {result && (
          <div
            role="status"
            className={cn(
              "nx-rise mt-5 flex items-start gap-3 rounded-2xl p-4",
              result.valid ? "bg-lime/15" : "bg-clay/25",
            )}
          >
            {result.valid ? (
              <ShieldCheck
                className="mt-0.5 size-5 text-lime"
                aria-hidden="true"
              />
            ) : (
              <ShieldX className="mt-0.5 size-5 text-clay" aria-hidden="true" />
            )}
            <div className="text-sm">
              <div className="font-medium">
                {result.valid
                  ? `Chain intact: all ${result.entries} entries verified.`
                  : `Tampering detected at entry #${result.brokenAt}.`}
              </div>
              <div className="text-machine-muted">
                {result.valid
                  ? "Every hash was recomputed in your browser and matches."
                  : `${result.reason} This entry and every entry after it can't be trusted.`}
              </div>
            </div>
          </div>
        )}
        <ol className="mt-5 space-y-2">
          {[...chain].reverse().map((e) => (
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
                  {e.kind.replace("_", " ")}
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
                {Object.entries(e.payload)
                  .map(
                    ([k, v]) =>
                      `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
                  )
                  .join(" · ")}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

const CHECKS = [
  [
    "Accepted file format",
    "PDF, JPEG or PNG under 5 MB; malformed files rejected",
  ],
  ["Not reused", "The same document can't back two listings"],
  ["Boundary is free", "No overlap with another listing"],
  [
    "Consent-labelled document attached",
    "Shows a document was attached, not that consent exists",
  ],
];

const NOT_CHECKED =
  "Whether documents are authentic; whether the issuing authority is real and the title current; legal validity and signatures; quorum and validity of community consent (FPIC); whether the drawn boundary matches the legal parcel; who the uploader really is.";

export function VerificationTab({ site }: { site: Site }) {
  const hasDocs = site.documents.length > 0;
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
      <ul className="mt-5 divide-y">
        {CHECKS.map(([name, note]) => {
          const pass = hasDocs || name === "Boundary is free";
          return (
            <li key={name} className="flex items-start gap-3 py-3">
              <span
                className={cn(
                  "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full",
                  pass
                    ? "bg-lime/30 text-lime-ink"
                    : "bg-secondary text-muted-foreground",
                )}
              >
                {pass ? (
                  <Check className="size-3.5" aria-label="pass" />
                ) : (
                  <CircleSlash className="size-3.5" aria-label="not run" />
                )}
              </span>
              <div>
                <div className="text-sm font-medium">{name}</div>
                <div className="text-xs text-muted-foreground">{note}</div>
              </div>
              <span className="ml-auto text-xs text-muted-foreground">
                {pass ? "Pass" : "Not run"}
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
