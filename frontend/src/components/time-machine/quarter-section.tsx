"use client";

import { FastForward, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
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
import type { TimeMachine, TimeMachineQuarter } from "@/lib/api/types";
import { useLiveEvent } from "@/lib/hooks";
import { quarterLabel } from "@/lib/prototype/format";
import {
  quarterFailure,
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
}: {
  state: TimeMachine;
  /** Listed sites a quarter re-rates, for the progress count. */
  listed: number;
  names: ReadonlyMap<string, string>;
  onRefresh: () => void;
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

  const run = async (next: TimeMachineQuarter) => {
    setRuns(new Map());
    const result = await quarter.mutate(next.period);
    if (!result) onRefresh();
  };

  const failure = quarter.error ? quarterFailure(quarter.error) : null;
  const done = [...runs.values()].filter((r) => r.done);
  const last = done.at(-1);
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
            onOpenChange={(open) => setConfirming(open ? next : null)}
          >
            <DialogTrigger asChild>
              <Button
                size="lg"
                className="bg-lime text-machine hover:bg-lime/90"
                disabled={!canRun || quarter.isPending}
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
                      {confirming.scenario}&rdquo; scenario. Prices re-anchor,
                      holders get alerts for big changes and the quarter&apos;s
                      revenue is paid. Only a demo reset undoes it.
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
                ? "Re-rates every listed site, re-anchors prices, alerts holders and pays the quarter."
                : "Reset the demo to start the timeline again."}
          </span>
        </div>
        <p role="status" aria-live="polite" className="mt-4 text-sm">
          {quarter.isPending &&
            `Re-rating sites: ${done.length} of ${Math.max(listed, runs.size)} done${
              last ? `. Latest: ${names.get(last.assetId) ?? "a site"}` : ""
            }.`}
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
