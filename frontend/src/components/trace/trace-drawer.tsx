"use client";

import { useMemo } from "react";

import { TraceError } from "@/components/agent-trace";
import { MachineRowsSkeleton } from "@/components/page-skeletons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AssetDetail, RecordedRun } from "@/lib/api/types";
import { useApiBase, useRunTrace } from "@/lib/hooks";
import { date } from "@/lib/prototype/format";
import { beforeAfterViews } from "@/lib/site-views";

import { TraceBody } from "./run-trace-page";

/**
 * The Agent Trace over the site's page (ADR-0008): every model call, search and check behind its
 * rating, without leaving the site. Its own rated run wins; a demo site nobody has rated in this
 * sandbox shows its recorded run, labelled with its date.
 */
export function TraceDrawer({
  open,
  onOpenChange,
  asset,
  runId,
  recorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: AssetDetail;
  runId: string | null;
  recorded: RecordedRun | null | undefined;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto overscroll-contain border-machine-line bg-machine p-0 text-machine-ink sm:max-w-5xl [&>[data-slot=sheet-close]]:text-machine-ink"
      >
        <SheetHeader className="gap-2 px-5 pt-7 pb-2 sm:px-8">
          <SheetTitle className="pr-8 font-serif text-3xl font-normal tracking-tight text-machine-ink sm:text-4xl">
            How {asset.name} was rated
          </SheetTitle>
          <SheetDescription className="max-w-[70ch] text-machine-muted">
            {runId
              ? "Every model call, search and check behind its Proof of Life, through Nebius Token Factory."
              : recorded
                ? `A real run of this site, recorded on ${date(recorded.recorded_on)} with the live models and web search. Rate the site to run it live.`
                : "Every model call, search and check behind its Proof of Life."}
          </SheetDescription>
        </SheetHeader>
        <div className="px-5 pb-10 sm:px-8">
          {open && (
            <SiteTrace asset={asset} runId={runId} recorded={recorded} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SiteTrace({
  asset,
  runId,
  recorded,
}: {
  asset: AssetDetail;
  runId: string | null;
  recorded: RecordedRun | null | undefined;
}) {
  const apiBase = useApiBase();
  const live = useRunTrace(runId ?? undefined);
  const views = beforeAfterViews(asset, apiBase);
  const recordedTrace = useMemo(
    () =>
      !runId && recorded ? { ...recorded.trace, asset_id: asset.id } : null,
    [runId, recorded, asset.id],
  );
  const trace = runId ? live.data : recordedTrace;

  if (trace) {
    return (
      <TraceBody
        trace={trace}
        views={views}
        recordedOn={runId ? undefined : recorded?.recorded_on}
      />
    );
  }
  if (runId && live.error) {
    return (
      <TraceError
        title={
          live.error.status === 404
            ? "This rating run's trace isn't available"
            : "We couldn't load the trace"
        }
        error={live.error}
        retry={live.error.status === 404 ? undefined : live.refetch}
      />
    );
  }
  if (!runId) {
    return (
      <p className="mt-4 text-machine-muted">
        Its trace appears here after its first rating.
      </p>
    );
  }
  return <MachineRowsSkeleton label="Loading the trace…" />;
}
