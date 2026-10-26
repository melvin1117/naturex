"use client";

import { ArrowLeft } from "lucide-react";
import Link from "@/components/app-link";
import { useEffect, useMemo } from "react";

import { TraceError } from "@/components/trace/trace-error";
import { MachineRowsSkeleton } from "@/components/page-skeletons";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RunTrace } from "@/lib/api/types";
import type { ApiError } from "@/lib/api/errors";
import {
  useApiBase,
  useAsset,
  useRecordedRun,
  useRunTrace,
  useShowCost,
} from "@/lib/hooks";
import { beforeAfterViews, type BeforeAfterViews } from "@/lib/site-views";
import { date } from "@/lib/format";
import {
  auditCase,
  auditChecks,
  costReceipt,
  newsFunnel,
  runFlow,
  runStory,
  runTimeline,
  seconds,
  usd,
  withoutCitations,
} from "@/lib/trace-view";

import { ActorChip } from "./actor";
import { TraceCase } from "./trace-case";
import { TraceChecks } from "./trace-checks";
import { TraceCost } from "./trace-cost";
import { TraceFlow } from "./trace-flow";
import { TraceStory } from "./trace-story";
import { TraceTimeline } from "./trace-timeline";

// The tabs sit on the machine layer: hover and focus need its colours too, or they fall back to
// the light theme's dark ink and vanish.
const TAB =
  "text-machine-muted hover:bg-machine-line/50 hover:text-machine-ink focus-visible:border-lime focus-visible:ring-lime focus-visible:outline-lime data-[state=active]:bg-machine-line data-[state=active]:text-machine-ink";

/** `/trace/[runId]`: one rating run, explained — who did what, why, what was checked, and what
 * it cost. Reads `GET /runs/{run_id}/trace`. */
export function RunTracePage({ runId }: { runId: string }) {
  const trace = useRunTrace(runId);
  const asset = useAsset(trace.data?.asset_id);
  const apiBase = useApiBase();
  return (
    <TraceShell
      assetId={trace.data?.asset_id}
      name={asset.data?.name}
      views={asset.data ? beforeAfterViews(asset.data, apiBase) : null}
      trace={trace.data}
      error={trace.error}
      retry={trace.refetch}
    />
  );
}

/** `/trace/recorded/[assetId]`: a demo site's recorded run (a real run committed as data), for
 * visitors who haven't rated the site themselves. Labelled "Recorded" with its date. */
export function RecordedTracePage({ assetId }: { assetId: string }) {
  const asset = useAsset(assetId);
  const apiBase = useApiBase();
  const recorded = useRecordedRun(asset.data?.site_key);
  const trace = useMemo(
    () =>
      recorded.data ? { ...recorded.data.trace, asset_id: assetId } : undefined,
    [recorded.data, assetId],
  );
  const notDemo = asset.data && !recorded.data && !recorded.isLoading;
  return (
    <TraceShell
      assetId={assetId}
      name={asset.data?.name}
      views={asset.data ? beforeAfterViews(asset.data, apiBase) : null}
      trace={trace}
      recordedOn={recorded.data?.recorded_on}
      error={recorded.error ?? asset.error ?? null}
      notFound={Boolean(notDemo && !recorded.error)}
      retry={() => (asset.error ? asset.refetch() : recorded.refetch())}
      liveRunId={asset.data?.latest_report?.run_id ?? null}
    />
  );
}

function TraceShell({
  assetId,
  name,
  views,
  trace,
  recordedOn,
  error,
  notFound = false,
  retry,
  liveRunId = null,
}: {
  assetId: string | undefined;
  name: string | undefined;
  views?: BeforeAfterViews | null;
  trace: RunTrace | undefined;
  recordedOn?: string;
  error: ApiError | null;
  notFound?: boolean;
  retry: () => unknown;
  /** The site's own rated run, which supersedes a recorded one. */
  liveRunId?: string | null;
}) {
  useEffect(() => {
    if (name) document.title = `How ${name} was rated · WildWorth`;
  }, [name]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {assetId && (
        <Link
          href={`/asset/${assetId}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {name ?? "Back to the site"}
        </Link>
      )}
      <h1 className="mt-3 font-serif text-4xl leading-tight text-foreground">
        {name ? `How ${name} was rated` : "How this site was rated"}
      </h1>
      {recordedOn && liveRunId && (
        <p className="mt-2 max-w-[70ch] rounded-2xl bg-card px-4 py-3 text-sm shadow-soft">
          This site has been rated in your demo since.{" "}
          <Link
            href={`/trace/${liveRunId}`}
            className="font-medium underline underline-offset-4"
          >
            Open that run&apos;s trace
          </Link>
          .
        </p>
      )}
      {recordedOn && (
        <p className="mt-2 max-w-[70ch] text-muted-foreground">
          A real rating run of this site, recorded on {date(recordedOn)} with
          the live models and web search, so you can see them at work without
          spending anything. Its numbers are that run&apos;s. Rate the site in
          your demo to run it live.
        </p>
      )}
      <div className="mt-6 rounded-[28px] bg-machine p-5 text-machine-ink sm:p-8">
        {!trace && (error || notFound) ? (
          <TraceError
            title={
              notFound || error?.status === 404
                ? "This rating run's trace isn't available"
                : "We couldn't load the trace"
            }
            error={error}
            retry={notFound || error?.status === 404 ? undefined : retry}
          />
        ) : !trace ? (
          <MachineRowsSkeleton label="Loading the trace…" />
        ) : (
          <TraceBody trace={trace} views={views} recordedOn={recordedOn} />
        )}
      </div>
    </div>
  );
}

/** One run, explained: the page's and the site drawer's body, on the machine layer. */
export function TraceBody({
  trace,
  views,
  recordedOn,
}: {
  trace: RunTrace;
  views?: BeforeAfterViews | null;
  recordedOn?: string;
}) {
  const showCost = useShowCost();
  const story = useMemo(() => runStory(trace, { showCost }), [trace, showCost]);
  const flow = useMemo(() => runFlow(trace), [trace]);
  const timeline = useMemo(() => runTimeline(trace), [trace]);
  const verdict = useMemo(() => auditCase(trace), [trace]);
  const receipt = useMemo(() => costReceipt(trace), [trace]);
  const funnel = useMemo(() => newsFunnel(trace), [trace]);
  const checks = useMemo(() => auditChecks(trace), [trace]);
  const done = trace.steps.find((s) => s.step === "done");
  const started = trace.steps[0]?.ts;
  const calls = receipt.models.reduce((n, m) => n + m.calls, 0);

  return (
    <>
      <header className="border-b border-machine-line pb-6">
        <p className="text-xs text-machine-muted">
          {recordedOn ? (
            <Badge className="mr-1 bg-machine-raised text-machine-ink">
              Recorded {date(recordedOn)}
            </Badge>
          ) : null}
          Run <span className="font-mono">{trace.run_id.slice(0, 8)}</span>
          {started && !recordedOn && ` · ${date(started)}`} · {trace.status} ·
          every model call through Nebius Token Factory
        </p>
        {verdict?.verdict && (
          <p className="mt-3 max-w-[70ch] font-serif text-2xl leading-snug sm:text-[28px]">
            {withoutCitations(verdict.verdict)}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-machine-muted">
          {verdict && verdict.source !== "fallback" && (
            <ActorChip
              actor="ultra"
              name="Judged by Nemotron 3 Ultra"
              note={
                verdict.reasoningTokens
                  ? `reasoning on, ${verdict.reasoningTokens.toLocaleString("en-US")} tokens`
                  : null
              }
            />
          )}
          <span className="tabular">
            {calls} model calls · {receipt.searches} web searches
            {receipt.reads > 0 &&
              ` · ${receipt.reads} page${receipt.reads === 1 ? "" : "s"} read`}{" "}
            · {seconds(done?.latency_ms ?? timeline.totalMs)}
            {showCost && (
              <>
                {" "}
                ·{" "}
                <span className="text-machine-ink">
                  {usd(receipt.totalUsd, 3)}
                </span>
                {receipt.savedPct
                  ? ` (${receipt.savedPct}% less than Ultra alone)`
                  : ""}
              </>
            )}
          </span>
        </div>
      </header>

      <Tabs defaultValue="story" className="mt-6 gap-6">
        <TabsList className="machine-scroll max-w-full justify-start overflow-x-auto bg-machine-raised">
          <TabsTrigger value="story" className={TAB}>
            Story
          </TabsTrigger>
          <TabsTrigger value="flow" className={TAB}>
            Flow
          </TabsTrigger>
          <TabsTrigger value="timeline" className={TAB}>
            Timeline
          </TabsTrigger>
          <TabsTrigger value="reasoning" className={TAB} disabled={!verdict}>
            Reasoning
          </TabsTrigger>
          <TabsTrigger value="checks" className={TAB}>
            Checks
          </TabsTrigger>
          {showCost && (
            <TabsTrigger value="cost" className={TAB}>
              Cost
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="story" className="max-w-3xl">
          <TraceStory lines={story} />
        </TabsContent>
        <TabsContent value="flow">
          <TraceFlow trace={trace} nodes={flow} views={views} />
        </TabsContent>
        <TabsContent value="timeline">
          <TraceTimeline totalMs={timeline.totalMs} lanes={timeline.lanes} />
        </TabsContent>
        <TabsContent value="reasoning">
          {verdict && <TraceCase c={verdict} />}
        </TabsContent>
        <TabsContent value="checks">
          <TraceChecks funnel={funnel} checks={checks} />
        </TabsContent>
        {showCost && (
          <TabsContent value="cost">
            <TraceCost receipt={receipt} />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
