"use client";

import { FastForward, RotateCw, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { toApiError } from "@/lib/api/errors";
import type { TimeMachine, TimeMachineQuarter } from "@/lib/api/types";
import { useLiveEvent } from "@/lib/hooks";
import { quarterLabel } from "@/lib/prototype/format";
import {
  isJobActive,
  jobFailure,
  needsReplay,
  quarterFailure,
  quarterJobProgressText,
  quarterOutcomeText,
  trackQuarterRun,
  type QuarterRun,
} from "@/lib/time-machine";
import { useQuarterJob, useSimulateQuarter } from "@/lib/time-machine-hooks";

import { QuarterResult } from "./quarter-result";
import { SentAlerts } from "./sent-alerts";

function stepNote(q: TimeMachineQuarter) {
  return q.data_version
    ? `Simulated: ${q.scenario} (${q.data_version})`
    : "Observed satellite data";
}

function Timeline({ state }: { state: TimeMachine }) {
  // Segments reached after the timeline was first drawn (a quarter run while the panel is
  // open) fill left to right, so the passing quarter is seen to pass.
  const [firstStep] = useState(state.step);
  return (
    <ol
      className="mt-8 grid gap-4 sm:grid-cols-3 sm:gap-2"
      aria-label="Quarters"
    >
      {state.timeline.map((q) => {
        const done = q.step < state.step;
        const now = q.step === state.step;
        return (
          <li key={q.step} aria-current={now ? "step" : undefined}>
            <div className="h-1.5 overflow-hidden rounded-full bg-machine-line">
              {q.step <= state.step && (
                <div
                  data-filled={q.step > firstStep ? "new" : "drawn"}
                  className={cn(
                    "h-full bg-lime",
                    q.step > firstStep &&
                      "animate-in duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] slide-in-from-left motion-reduce:animate-none",
                  )}
                />
              )}
            </div>
            <div className="mt-3">
              <div
                className={cn(
                  "text-sm font-medium",
                  !done && !now && "text-machine-muted",
                )}
              >
                {quarterLabel(q.period)}
                {now && <span className="text-lime"> · now</span>}
              </div>
              <div className="text-xs text-machine-muted">{stepNote(q)}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The timeline, "Next quarter" with its confirmation, then the quarter's job (#201): its
 * progress (polled, plus the live `rating_progress` runs) and its per-site results as they
 * settle.
 */
export function QuarterSection({
  state,
  listed,
  names,
  onRefresh,
  onPendingChange,
}: {
  state: TimeMachine;
  /** Listed sites a quarter re-rates, for the confirmation. */
  listed: number;
  names: ReadonlyMap<string, string>;
  onRefresh: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const quarter = useSimulateQuarter();
  const [started, setStarted] = useState<string | null>(null);
  // A job running in this sandbox wins (a reload, another tab, or a refused second start);
  // then the job this panel started; then the sandbox's last one, so a reload still shows
  // what it did and offers to finish it.
  const latest = state.quarter_job;
  const jobId =
    latest && isJobActive(latest) ? latest.id : (started ?? latest?.id ?? null);
  const job = useQuarterJob(jobId);
  const result = jobId && job.data?.id === jobId ? job.data : undefined;
  const [confirming, setConfirming] = useState<TimeMachineQuarter | null>(null);
  const [runs, setRuns] = useState<ReadonlyMap<string, QuarterRun>>(new Map());

  const running =
    quarter.isPending ||
    (jobId !== null && (result ? isJobActive(result) : !job.error));

  useLiveEvent(
    "rating_progress",
    ({ payload }) =>
      setRuns((current) => trackQuarterRun(current, payload) ?? current),
    { enabled: running },
  );

  useEffect(() => {
    onPendingChange?.(running);
    return () => onPendingChange?.(false);
  }, [running, onPendingChange]);

  const run = async (period: string) => {
    setRuns(new Map());
    try {
      const created = await quarter.mutateAsync(period);
      setStarted(created.id);
    } catch (error) {
      if (quarterFailure(toApiError(error)).refresh) onRefresh();
    }
  };

  const failure =
    (quarter.error ? quarterFailure(quarter.error) : null) ??
    jobFailure(result);
  const next = state.next;
  const canRun = Boolean(next) && state.local_jobs;
  const replay = !running && state.local_jobs && needsReplay(result);

  return (
    <>
      <section
        className="mt-8 rounded-[2rem] bg-machine p-6 text-machine-ink shadow-lift sm:p-8"
        aria-labelledby="timeline-title"
      >
        <h2 id="timeline-title" className="font-serif text-3xl">
          Now: {quarterLabel(state.current.period)}
        </h2>
        <p className="mt-1 text-sm text-machine-muted">
          {stepNote(state.current)}
        </p>
        <Timeline state={state} />
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Dialog
            open={confirming !== null}
            onOpenChange={(open) =>
              setConfirming(open && !running ? next : null)
            }
          >
            <DialogTrigger asChild>
              {/* aria-disabled, not disabled, while it runs: the dialog hands focus back
                  here, and a disabled button would drop it to the page. */}
              <Button
                size="lg"
                className="bg-lime text-machine hover:bg-lime/90 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-lime aria-disabled:active:translate-y-0"
                disabled={!canRun && !running}
                aria-disabled={running || undefined}
                data-tour="next-quarter"
              >
                {running ? (
                  <Spinner aria-hidden="true" role="presentation" />
                ) : (
                  <FastForward aria-hidden="true" />
                )}
                {running
                  ? "Running the quarter…"
                  : next
                    ? `Next quarter: ${quarterLabel(next.period)}`
                    : "End of the scripted timeline"}
              </Button>
            </DialogTrigger>
            {confirming && (
              <DialogContent>
                <form
                  className="grid gap-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setConfirming(null);
                    void run(confirming.period);
                  }}
                >
                  <DialogHeader>
                    <DialogTitle>
                      Move this sandbox to {quarterLabel(confirming.period)}?
                    </DialogTitle>
                    <DialogDescription>
                      Every listed site ({listed}) is re-rated with the &ldquo;
                      {confirming.scenario}&rdquo; scenario. Stake prices
                      re-anchor, holders get alerts for big changes and the
                      quarter&apos;s revenue is paid. Only a demo reset undoes
                      it.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="outline">
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="submit">
                      Run {quarterLabel(confirming.period)}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            )}
          </Dialog>
          {replay && result && (
            <Button
              variant="outline"
              size="lg"
              className="border-machine-line bg-transparent text-machine-ink hover:bg-machine-line/40 hover:text-machine-ink"
              onClick={() => void run(result.period)}
            >
              <RotateCw aria-hidden="true" />
              Finish {quarterLabel(result.period)}
            </Button>
          )}
          <span className="text-sm text-machine-muted">
            {!state.local_jobs
              ? "Quarters run in-process only with LOCAL_JOBS=true, which is off on this server. Event presets still work."
              : running
                ? "The quarter runs on the server: you can leave this page and come back."
                : next
                  ? "Re-rates every listed site, re-anchors stake prices, alerts holders and pays the quarter."
                  : "Reset the demo to start the timeline again."}
          </span>
        </div>
        <p role="status" aria-live="polite" className="mt-4 text-sm">
          {running
            ? quarterJobProgressText(result, runs, names)
            : result && quarterOutcomeText(result)}
        </p>
      </section>

      {failure && (
        <Alert variant="destructive" className="mt-6">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>
            <p>{failure.message}</p>
          </AlertDescription>
        </Alert>
      )}

      {job.error && (
        <Alert variant="destructive" className="mt-6">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>We couldn&apos;t check the quarter</AlertTitle>
          <AlertDescription>
            <p>{job.error.message}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void job.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {result && (result.assets.length > 0 || !isJobActive(result)) && (
        <section
          aria-label="Quarter result"
          aria-busy={isJobActive(result) || undefined}
          className="mt-6 grid gap-8 rounded-3xl bg-card p-6 shadow-soft lg:grid-cols-[minmax(0,1fr)_20rem]"
        >
          <QuarterResult result={result} />
          <SentAlerts ids={result.assets.flatMap((a) => a.alert_ids ?? [])} />
        </section>
      )}
    </>
  );
}
