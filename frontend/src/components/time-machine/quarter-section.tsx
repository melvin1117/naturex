"use client";

import { FastForward, TriangleAlertIcon } from "lucide-react";
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
  quarterFailure,
  quarterOutcomeText,
  quarterProgressText,
  trackQuarterRun,
  type QuarterRun,
} from "@/lib/time-machine";
import { useSimulateQuarter } from "@/lib/time-machine-hooks";

import { QuarterResult } from "./quarter-result";
import { SentAlerts } from "./sent-alerts";

function stepNote(q: TimeMachineQuarter) {
  return q.data_version
    ? `Simulated: ${q.scenario} (${q.data_version})`
    : "Observed satellite data";
}

function Timeline({ state }: { state: TimeMachine }) {
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
            <div
              className={cn(
                "h-1.5 rounded-full",
                q.step <= state.step ? "bg-lime" : "bg-machine-line",
              )}
            />
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

/** The timeline, "Next quarter" with its confirmation, live progress and the result. */
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
  const [confirming, setConfirming] = useState<TimeMachineQuarter | null>(null);
  const [runs, setRuns] = useState<ReadonlyMap<string, QuarterRun>>(new Map());

  useLiveEvent(
    "rating_progress",
    ({ payload }) =>
      setRuns((current) => trackQuarterRun(current, payload) ?? current),
    { enabled: quarter.isPending },
  );

  useEffect(() => {
    onPendingChange?.(quarter.isPending);
    return () => onPendingChange?.(false);
  }, [quarter.isPending, onPendingChange]);

  const run = async (next: TimeMachineQuarter) => {
    setRuns(new Map());
    try {
      await quarter.mutateAsync(next.period);
    } catch (error) {
      if (quarterFailure(toApiError(error)).refresh) onRefresh();
    }
  };

  const failure = quarter.error ? quarterFailure(quarter.error) : null;
  const next = state.next;
  const canRun = Boolean(next) && state.local_jobs;

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
              setConfirming(open && !quarter.isPending ? next : null)
            }
          >
            <DialogTrigger asChild>
              {/* aria-disabled, not disabled, while it runs: the dialog hands focus back
                  here, and a disabled button would drop it to the page. */}
              <Button
                size="lg"
                className="bg-lime text-machine hover:bg-lime/90 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-lime aria-disabled:active:translate-y-0"
                disabled={!canRun}
                aria-disabled={quarter.isPending || undefined}
                data-tour="next-quarter"
              >
                {quarter.isPending ? (
                  <Spinner aria-hidden="true" role="presentation" />
                ) : (
                  <FastForward aria-hidden="true" />
                )}
                {quarter.isPending
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
                    void run(confirming);
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
          <span className="text-sm text-machine-muted">
            {!state.local_jobs
              ? "Quarters run in-process only with LOCAL_JOBS=true, which is off on this server. Event presets still work."
              : next
                ? "Re-rates every listed site, re-anchors stake prices, alerts holders and pays the quarter."
                : "Reset the demo to start the timeline again."}
          </span>
        </div>
        <p role="status" aria-live="polite" className="mt-4 text-sm">
          {quarter.isPending
            ? quarterProgressText(runs, names)
            : quarter.data && quarterOutcomeText(quarter.data)}
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

      {quarter.data && (
        <section
          aria-label="Quarter result"
          className="mt-6 grid gap-8 rounded-3xl bg-card p-6 shadow-soft lg:grid-cols-[minmax(0,1fr)_20rem]"
        >
          <QuarterResult result={quarter.data} />
          <SentAlerts
            ids={quarter.data.assets.flatMap((a) => a.alert_ids ?? [])}
          />
        </section>
      )}
    </>
  );
}
