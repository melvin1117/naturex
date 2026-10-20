"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "cn";

import { MarkdownText } from "@/components/markdown-text";
import { LoadError } from "@/components/proto/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MetricChange, ReportDiff } from "@/lib/api/types";
import { useReportDiff } from "@/lib/hooks";
import {
  formatMetricDelta,
  formatMetricValue,
  groupMetrics,
  metricDirection,
} from "@/lib/report-diff";

const REASON_SOURCE: Record<ReportDiff["reasons"][number]["source"], string> = {
  auditor: "Auditor",
  event: "News",
  flag: "Flag",
  data: "Data",
  scenario: "Scenario",
};

function Direction({ direction }: { direction: "up" | "down" | null }) {
  if (!direction) return null;
  const Icon = direction === "up" ? ArrowUpRight : ArrowDownRight;
  return (
    <Icon
      className="size-3.5 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );
}

/** One changed value: before, after, and the change under it. */
function ValueCells({
  old,
  now,
  change,
  direction,
}: {
  old: string;
  now: string;
  change: string;
  direction: "up" | "down" | null;
}) {
  return (
    <>
      <TableCell className="tabular py-2 text-right align-top text-muted-foreground">
        {old}
      </TableCell>
      <TableCell className="tabular py-2 pr-0 text-right align-top">
        <span className="inline-flex items-center gap-1">
          <Direction direction={direction} />
          {now}
        </span>
        <div className="text-xs text-muted-foreground">{change}</div>
      </TableCell>
    </>
  );
}

function MetricRow({
  metric,
  reasonCount,
  reasonHref,
  onReason,
}: {
  metric: MetricChange;
  reasonCount: number;
  reasonHref: (i: number) => string;
  onReason: (i: number) => void;
}) {
  const refs = metric.reason_refs.filter((r) => r >= 0 && r < reasonCount);
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="py-2 pl-0 align-top whitespace-normal">
        {metric.label}
        {refs.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span aria-hidden="true">Why</span>
            {refs.map((r) => (
              <a
                key={r}
                href={reasonHref(r)}
                onClick={(e) => {
                  e.preventDefault();
                  onReason(r);
                }}
                aria-label={`Reason ${r + 1}: why ${metric.label} changed`}
                className="tabular inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-secondary px-1.5 text-foreground hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {r + 1}
              </a>
            ))}
          </div>
        )}
      </TableCell>
      <ValueCells
        old={formatMetricValue(metric, metric.old)}
        now={formatMetricValue(metric, metric.new)}
        change={formatMetricDelta(metric)}
        direction={metricDirection(metric)}
      />
    </TableRow>
  );
}

function GroupHeading({ label }: { label: string }) {
  return (
    <TableRow className="border-b-0 hover:bg-transparent">
      <TableHead
        scope="colgroup"
        colSpan={3}
        className="h-auto px-0 pt-4 pb-1 text-xs font-medium text-muted-foreground"
      >
        {label}
      </TableHead>
    </TableRow>
  );
}

/**
 * "What changed since vN" for a real asset, from the diff API (T37, #189): the changed
 * numbers (headline first, the rest on request), the grade change and the stored reasons,
 * each number linked to the reasons that cite it.
 */
export function ReportChanges({
  reportId,
  prevId,
}: {
  reportId: string;
  prevId: string;
}) {
  const diff = useReportDiff(reportId, prevId);
  const base = useId();
  const [showAll, setShowAll] = useState(false);
  const [focused, setFocused] = useState<number | null>(null);

  if (!diff.data) {
    if (diff.error)
      return (
        <LoadError
          title="We couldn't load what changed"
          error={diff.error}
          retry={diff.refetch}
        />
      );
    return (
      <div role="status" className="space-y-2">
        <p className="text-xs text-muted-foreground">Loading what changed…</p>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className="h-8 animate-pulse rounded-lg bg-foreground/6 motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }

  const {
    grade_change: grade,
    metrics,
    reasons,
    from_version,
    to_version,
  } = diff.data;
  const groups = groupMetrics(metrics);
  const headline = groups.find((g) => g.group === "headline")?.rows ?? [];
  const rest = groups.filter((g) => g.group !== "headline");
  const restCount = rest.reduce((n, g) => n + g.rows.length, 0);
  const hasHeadline = Boolean(grade) || headline.length > 0;
  const expanded = showAll || !hasHeadline;
  const reasonId = (i: number) => `${base}-reason-${i}`;

  const jumpToReason = (i: number) => {
    setFocused(i);
    const el = document.getElementById(reasonId(i));
    if (!el) return;
    el.focus({ preventScroll: true });
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollIntoView({
      block: "center",
      behavior: reduce ? "auto" : "smooth",
    });
  };
  const row = (m: MetricChange) => (
    <MetricRow
      key={m.id}
      metric={m}
      reasonCount={reasons.length}
      reasonHref={(i) => `#${reasonId(i)}`}
      onReason={jumpToReason}
    />
  );

  return (
    <>
      {!grade && metrics.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No numbers changed between v{from_version} and v{to_version}.
        </p>
      ) : (
        <Table className="table-fixed">
          <caption className="sr-only">
            Numbers that changed from v{from_version} to v{to_version}
          </caption>
          <colgroup>
            <col />
            <col className="w-[28%]" />
            <col className="w-[30%]" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8 px-0 text-xs text-muted-foreground">
                Metric
              </TableHead>
              <TableHead className="h-8 text-right text-xs text-muted-foreground">
                v{from_version}
              </TableHead>
              <TableHead className="h-8 pr-0 text-right text-xs text-muted-foreground">
                v{to_version}
              </TableHead>
            </TableRow>
          </TableHeader>
          {hasHeadline && (
            <TableBody>
              {grade && (
                <TableRow className="hover:bg-transparent">
                  <TableCell className="py-2 pl-0 align-top">Grade</TableCell>
                  <ValueCells
                    old={grade.old ?? "—"}
                    now={grade.new ?? "—"}
                    change={
                      grade.direction === "up"
                        ? "Upgraded"
                        : grade.direction === "down"
                          ? "Downgraded"
                          : "Changed"
                    }
                    direction={grade.direction}
                  />
                </TableRow>
              )}
              {headline.map(row)}
            </TableBody>
          )}
          {expanded &&
            rest.map((g) => (
              <TableBody key={g.group}>
                <GroupHeading label={g.label} />
                {g.rows.map(row)}
              </TableBody>
            ))}
        </Table>
      )}
      {hasHeadline && restCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 -ml-2"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll
            ? "Show headline changes only"
            : `Show ${restCount} more changed ${restCount === 1 ? "number" : "numbers"}`}
        </Button>
      )}
      <div className="mt-5">
        <h4 className="text-sm font-medium">Why it changed</h4>
        {reasons.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No reasons were recorded between these versions.
          </p>
        ) : (
          <ol className="mt-2 space-y-1">
            {reasons.map((r, i) => (
              <li
                key={`${i}-${r.text}`}
                id={reasonId(i)}
                tabIndex={-1}
                className={cn(
                  "flex scroll-mt-24 items-start gap-2 rounded-xl p-1.5 text-sm outline-none",
                  focused === i && "bg-lime/25 ring-2 ring-lime",
                )}
              >
                <span className="tabular mt-0.5 w-4 shrink-0 text-right text-xs text-muted-foreground">
                  <span className="sr-only">Reason </span>
                  {i + 1}
                </span>
                <Badge variant="secondary" className="mt-0.5 shrink-0">
                  {REASON_SOURCE[r.source]}
                </Badge>
                <MarkdownText text={r.text} className="min-w-0 break-words" />
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
