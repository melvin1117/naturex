"use client";

import {
  Check,
  CircleDashed,
  CircleSlash,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "cn";

import {
  PIPELINE_STAGES,
  type PipelineStage,
  type PipelineView,
  type StageState,
} from "@/lib/listing";

const STATE_TEXT: Record<StageState, string> = {
  waiting: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "not run",
};

const PHASE_TEXT: Record<PipelineView["phase"], string> = {
  queued: "Queued for a rating worker…",
  running: "Agents at work…",
  succeeded: "Rating finished.",
  degraded: "Rating finished with a fallback.",
  failed: "The rating stopped.",
};

/**
 * A real rating run (T27) as the prototype's lit pipeline on the machine layer: each step
 * lights up as its `rating_progress` event arrives. Latencies and models come from the run.
 */
export function RatingProgress({
  view,
  className,
}: {
  view: PipelineView | null;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[1.75rem] bg-machine p-5 text-machine-ink shadow-soft",
        className,
      )}
      aria-labelledby="rating-pipeline-title"
    >
      <div className="px-3 pt-1 pb-3">
        <h2 id="rating-pipeline-title" className="font-serif text-2xl">
          Rating pipeline
        </h2>
        <p className="text-sm text-machine-muted" role="status">
          {view
            ? view.current
              ? `${PHASE_TEXT[view.phase]} ${view.current}.`
              : PHASE_TEXT[view.phase]
            : "Steps light up as each agent and tool runs."}
        </p>
      </div>
      <ol className="relative space-y-1">
        {(view?.stages ?? IDLE_STAGES).map((stage) => (
          <StageRow key={stage.step} {...stage} />
        ))}
      </ol>
      {view && (view.fallback || view.degraded) && (
        <p className="mx-3 mt-3 flex gap-2 rounded-2xl bg-machine-raised px-3 py-2 text-xs text-machine-muted">
          <TriangleAlert
            className="mt-0.5 size-3.5 shrink-0 text-lime"
            aria-hidden="true"
          />
          <span>
            {view.fallback
              ? "The fixed pipeline took over from the AI orchestrator: its steps run on tested formulas only."
              : "A fallback was used for part of this rating."}
            {view.reasons.length > 0 && ` (${view.reasons.join(", ")})`}
          </span>
        </p>
      )}
      {view?.phase === "failed" &&
        view.error &&
        !view.stages.some((stage) => stage.error === view.error) && (
          <p className="mx-3 mt-3 text-xs text-machine-muted">
            Stopped with <code className="font-mono">{view.error}</code>.
          </p>
        )}
    </section>
  );
}

const IDLE_STAGES: PipelineStage[] = PIPELINE_STAGES.map((stage) => ({
  ...stage,
  state: "waiting",
  model: null,
  tool: null,
  latencyMs: null,
  error: null,
}));

function StageRow({
  label,
  detail,
  state,
  model,
  latencyMs,
  error,
}: PipelineStage) {
  const lit = state === "done" || state === "running";
  return (
    <li
      className={cn(
        "relative flex items-start gap-3 rounded-2xl px-3 py-2.5 transition-colors duration-300",
        state === "running" && "bg-machine-raised",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl transition-colors duration-300",
          state === "done"
            ? "bg-lime text-machine"
            : state === "running"
              ? "bg-machine-line text-lime"
              : state === "failed"
                ? "bg-clay text-white"
                : "bg-machine-raised text-machine-muted",
        )}
        aria-hidden="true"
      >
        {state === "done" ? (
          <Check className="size-4" />
        ) : state === "running" ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        ) : state === "failed" ? (
          <X className="size-4" />
        ) : state === "skipped" ? (
          <CircleSlash className="size-4" />
        ) : (
          <CircleDashed className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "text-sm font-medium",
            lit || state === "failed"
              ? "text-machine-ink"
              : "text-machine-muted",
          )}
        >
          {label}
        </span>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-machine-muted">
          {detail && <span>{detail}</span>}
          {model && <span>· {model}</span>}
          {state === "done" && latencyMs !== null && (
            <span className="tabular">· {(latencyMs / 1000).toFixed(1)} s</span>
          )}
          {state === "failed" && error && (
            <span>
              · <code className="font-mono">{error}</code>
            </span>
          )}
        </div>
        {state === "running" && (
          <div className="nx-flow mt-2 h-0.5 rounded-full" />
        )}
      </div>
      <span className="sr-only">{STATE_TEXT[state]}</span>
    </li>
  );
}
