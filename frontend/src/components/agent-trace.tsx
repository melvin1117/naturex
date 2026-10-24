"use client";

import {
  ArrowRight,
  ChevronDown,
  CircleDot,
  Cpu,
  Lock,
  RefreshCwIcon,
  Wrench,
} from "lucide-react";
import Link from "@/components/app-link";
import { useState } from "react";
import { cn } from "cn";

import { MachineRowsSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ApiError } from "@/lib/api/errors";
import type { RunTrace } from "@/lib/api/types";
import { curatedSite, MODEL_CALLS_EMPTY } from "@/lib/empty-states";
import {
  useAsset,
  useAssetReports,
  useAssets,
  useRunTrace,
  useShowCost,
  useWorldTrace,
} from "@/lib/hooks";
import { date } from "@/lib/prototype/format";
import { agentLabel } from "@/lib/bea";
import {
  auditCase,
  modelLabel,
  runStory,
  withoutCitations,
} from "@/lib/trace-view";
import { TraceStory } from "@/components/trace/trace-story";
import {
  modelName,
  runOptions,
  traceRows,
  traceTotals,
  type TraceRow,
  type TraceStepKind,
} from "@/lib/run-trace";

const ICON: Record<TraceStepKind, typeof Cpu> = {
  llm: Cpu,
  tool: Wrench,
  seal: Lock,
  event: CircleDot,
};

const SELECT_CLASS =
  "w-full border-machine-line bg-machine-raised text-machine-ink";

function seconds(ms: number | null) {
  return ms === null ? "—" : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function tokens(n: number) {
  return n.toLocaleString("en-US");
}

/**
 * The Agent Trace of a real site (T34): pick one of its rating runs, then every step it took,
 * read from `GET /runs/{run_id}/trace`. `initialRunId` is the run the drawer was opened on.
 */
export function AssetRunsTrace({
  assetId,
  initialRunId,
}: {
  assetId: string;
  initialRunId: string | null;
}) {
  const asset = useAsset(assetId);
  const reports = useAssetReports(assetId);
  const [picked, setPicked] = useState<string | null>(null);
  const options = runOptions(reports.data, [
    initialRunId,
    asset.data?.latest_run_id,
  ]);
  // The default run needs both the asset (a listing's latest run) and its reports: choosing
  // before both answer would show one run, then switch to another (a second fetch).
  const settled = [asset, reports].every(
    (q) => q.data !== undefined || q.error,
  );
  const runId =
    picked ?? initialRunId ?? (settled ? options[0]?.runId : null) ?? null;

  if (!runId) {
    if (!settled) return <MachineRowsSkeleton label="Loading rating runs…" />;
    if (reports.error && !reports.data)
      return (
        <TraceError
          title="We couldn't load this site's rating runs"
          error={reports.error}
          retry={reports.refetch}
        />
      );
    return (
      <p className="rounded-2xl bg-machine-raised px-4 py-3 text-sm text-machine-muted">
        No rating run has been recorded for this site yet. Its reports were
        seeded, so there are no model calls to show. A re-rate or a new listing
        records one.
      </p>
    );
  }

  return (
    <>
      {settled && options.length > 1 && (
        <Select value={runId} onValueChange={setPicked}>
          <SelectTrigger className={SELECT_CLASS} aria-label="Rating run">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.runId} value={o.runId}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {settled && options.length === 1 && (
        <p className="text-sm text-machine-muted">{options[0]!.label}</p>
      )}
      <RunTraceView key={runId} runId={runId} />
    </>
  );
}

/** One rating run's steps, with loading, error and empty states. */
export function RunTraceView({ runId }: { runId: string }) {
  const trace = useRunTrace(runId);
  if (!trace.data && trace.error)
    return (
      <TraceError
        title={
          trace.error.status === 404
            ? "This rating run's trace isn't available"
            : "We couldn't load the trace"
        }
        error={trace.error}
        retry={trace.error.status === 404 ? undefined : trace.refetch}
      />
    );
  if (!trace.data)
    return <MachineRowsSkeleton label="Loading the trace…" className="mt-4" />;
  return <RunTraceBody trace={trace.data} />;
}

function RunTraceBody({ trace }: { trace: RunTrace }) {
  const showCost = useShowCost();
  const rows = traceRows(trace);
  const totals = traceTotals(trace);
  if (rows.length === 0)
    return (
      <p className="mt-4 text-sm text-machine-muted">
        This run hasn&apos;t recorded any steps yet.
      </p>
    );
  const story = runStory(trace, { showCost });
  const audit = auditCase(trace);
  return (
    <>
      {audit?.verdict && (
        <p className="mt-4 font-serif text-xl leading-snug text-machine-ink">
          {withoutCitations(audit.verdict)}
        </p>
      )}
      <Link
        href={`/trace/${trace.run_id}`}
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-lime underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none"
      >
        Open the full trace: flow, timeline, reasoning, checks
        {showCost ? " and cost" : ""}
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
      {story.length > 0 && (
        <div className="mt-5">
          <TraceStory lines={story} compact />
        </div>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Model calls", String(totals.llmCalls)],
          ["Tokens", tokens(totals.tokens)],
          ["Time", seconds(totals.durationMs)],
          ...(showCost ? [["Cost", `$${totals.costUsd.toFixed(4)}`]] : []),
        ].map(([k, v]) => (
          <div key={k} className="rounded-2xl bg-machine-raised px-3 py-2.5">
            <dt className="text-[11px] text-machine-muted">{k}</dt>
            <dd className="tabular mt-0.5 text-lg font-light">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-machine-muted">
        Recorded by the rating run: run{" "}
        <span className="font-mono">{trace.run_id.slice(0, 8)}</span>,{" "}
        {trace.status}. Prompts and raw model output are never shown; tool
        outputs are safe summaries.
        {totals.llmCalls === 0 &&
          " No model was called in this run: every step ran as code (no model key, or the models were unavailable)."}
      </p>
      <ol className="mt-4 space-y-2" aria-label="Run steps">
        {rows.map((row) => (
          <RealStepRow key={row.key} row={row} />
        ))}
      </ol>
    </>
  );
}

function RealStepRow({ row }: { row: TraceRow }) {
  const showCost = useShowCost();
  const [open, setOpen] = useState(false);
  const Icon = ICON[row.kind];
  const detail = row.output || row.error || row.calls.length > 0;
  const model = modelName(row.model);
  const meta = (
    <>
      <span className="block text-sm font-medium">{row.label}</span>
      <span className="mt-0.5 block text-xs text-machine-muted">
        {row.agent}
        {model && ` · ${model}`}
      </span>
      <span className="tabular mt-1 flex flex-wrap gap-x-3 text-[11px] text-machine-muted">
        <span
          className={cn(
            row.failed ? "font-medium text-clay" : "text-machine-muted",
          )}
        >
          {row.statusLabel}
        </span>
        {row.latencyMs !== null && <span>{seconds(row.latencyMs)}</span>}
        {row.tokensIn + row.tokensOut > 0 && (
          <span>
            {tokens(row.tokensIn)} in · {tokens(row.tokensOut)} out
          </span>
        )}
        {showCost && row.costUsd > 0 && <span>${row.costUsd.toFixed(5)}</span>}
        {row.attempts !== null && row.attempts > 1 && (
          <span>{row.attempts} attempts</span>
        )}
      </span>
    </>
  );
  const badge = (
    <span
      className={cn(
        "mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl",
        row.kind === "llm"
          ? "bg-lime text-machine"
          : "bg-machine-line text-machine-ink",
      )}
      aria-hidden="true"
    >
      <Icon className="size-4" />
    </span>
  );
  return (
    <li className="rounded-2xl bg-machine-raised">
      {detail ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none"
        >
          {badge}
          <span className="min-w-0 flex-1">{meta}</span>
          <ChevronDown
            className={cn(
              "mt-1 size-4 shrink-0 text-machine-muted transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      ) : (
        <div className="flex items-start gap-3 px-4 py-3">
          {badge}
          <span className="min-w-0 flex-1">{meta}</span>
        </div>
      )}
      {open && detail && (
        <div className="space-y-2 px-4 pb-4">
          {row.error && <p className="text-xs text-clay">Error: {row.error}</p>}
          {row.calls.length > 0 && (
            <div>
              <p className="text-xs text-machine-muted">Model attempts</p>
              <ul className="mt-1 space-y-1">
                {row.calls.map((c, i) => (
                  <li
                    key={c.id ?? i}
                    className="tabular rounded-xl bg-machine px-3 py-2 text-[11px] text-machine-muted"
                  >
                    <span className="text-machine-ink">
                      {agentLabel(
                        c.agent,
                        c.model ? modelLabel(c.model) : null,
                      ) ?? "model"}
                    </span>
                    {" · "}
                    <span className="font-mono">{c.model ?? "—"}</span>
                    {" · "}
                    {c.status}
                    {c.prompt_tokens != null &&
                      ` · ${tokens(c.prompt_tokens)} in · ${tokens(c.completion_tokens ?? 0)} out`}
                    {c.latency_ms != null && ` · ${seconds(c.latency_ms)}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {row.output && (
            <div>
              <p className="text-xs text-machine-muted">Output summary</p>
              <pre className="machine-scroll mt-1 max-h-64 overflow-auto rounded-xl bg-machine p-3 font-mono text-[11px] leading-relaxed text-machine-ink">
                {JSON.stringify(row.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Away from a site: the world's latest logged model calls (`GET /admin/trace`), newest first,
 * with a pointer to the per-run trace on each site.
 */
export function WorldModelCalls() {
  const trace = useWorldTrace();
  const assets = useAssets();
  if (!trace.data && trace.error)
    return (
      <TraceError
        title="We couldn't load the model calls"
        error={trace.error}
        retry={trace.refetch}
      />
    );
  if (!trace.data)
    return <MachineRowsSkeleton label="Loading model calls…" intro />;
  const calls = trace.data.steps;
  const howItWasRated = (
    <>
      Open a site: its{" "}
      <span className="text-machine-ink">How the AI rated it</span> card shows
      every step of its rating runs.
    </>
  );
  if (calls.length === 0) {
    const site = curatedSite(assets.data);
    return (
      <div className="rounded-2xl bg-machine-raised px-4 py-4 text-sm">
        <p className="font-medium text-machine-ink">
          {MODEL_CALLS_EMPTY.title}
        </p>
        <p className="mt-1 text-machine-muted">{MODEL_CALLS_EMPTY.body}</p>
        <p className="mt-3 text-machine-muted">{howItWasRated}</p>
        {site && (
          // On a site's page, this drawer shows that site's rating runs.
          <Link
            href={`/asset/${site.id}`}
            className="mt-3 inline-flex items-center gap-1.5 font-medium text-lime underline-offset-4 hover:underline"
          >
            See how {site.name} was rated
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        )}
      </div>
    );
  }
  return (
    <>
      <p className="text-sm text-machine-muted">
        The latest model calls in your world. {howItWasRated}
      </p>
      <ol className="mt-4 space-y-2" aria-label="Latest model calls">
        {calls.map((c, i) => (
          <li
            key={`${c.created_at}-${i}`}
            className="rounded-2xl bg-machine-raised px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">
                {agentLabel(c.agent, c.model ? modelLabel(c.model) : null) ??
                  "Model call"}
              </span>
              <span className="text-[11px] text-machine-muted">
                {date(c.created_at)}
              </span>
            </div>
            <div className="mt-0.5 text-xs text-machine-muted">
              {modelName(c.model) ?? "—"}
            </div>
            <div className="tabular mt-1 flex flex-wrap gap-x-3 text-[11px] text-machine-muted">
              <span
                className={cn(c.status !== "ok" && "font-medium text-clay")}
              >
                {c.status === "ok" ? "Done" : c.status}
              </span>
              {c.latency_ms != null && <span>{seconds(c.latency_ms)}</span>}
              {c.prompt_tokens != null && (
                <span>
                  {tokens(c.prompt_tokens)} in ·{" "}
                  {tokens(c.completion_tokens ?? 0)} out
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

export function TraceError({
  title,
  error,
  retry,
}: {
  title: string;
  error: ApiError | null;
  retry?: () => unknown;
}) {
  return (
    <div
      role="alert"
      className="mt-4 rounded-2xl bg-clay/20 px-4 py-3 text-sm text-machine-ink"
    >
      <p className="font-medium">{title}</p>
      {error && <p className="mt-0.5 text-machine-muted">{error.message}</p>}
      {retry && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 border-machine-line bg-transparent text-machine-ink hover:bg-machine-line"
          onClick={() => void retry()}
        >
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}
