import { ArrowRight } from "lucide-react";
import Link from "next/link";

import type { ReportOut } from "@/lib/api/types";
import { modelLabel, withoutCitations } from "@/lib/trace-view";

import { ActorChip } from "./actor";

/** Under a site's header: the Auditor's verdict in one line, who judged it, and the way to
 * the full trace. Shown only for a report with a verdict and a recorded run. */
export function VerdictStrip({
  report,
}: {
  report: ReportOut | null | undefined;
}) {
  const verdict = report?.auditor?.verdict;
  const runId = report?.run_id;
  if (!verdict || !runId) return null;
  const adjustment = report?.auditor?.auditor_adjustment ?? 0;
  return (
    <section
      aria-label="The Auditor's verdict"
      className="mt-6 rounded-[1.75rem] bg-machine px-6 py-5 text-machine-ink sm:px-8"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ActorChip
          actor="ultra"
          name={`Judged by ${modelLabel("nvidia/Nemotron-3-Ultra-550b-a55b")}`}
          note="reasoning on"
        />
        <span className="text-xs text-machine-muted">
          {adjustment === 0
            ? "No change to the formula's health"
            : `Health ${adjustment > 0 ? "+" : "−"}${Math.abs(adjustment)} with cited evidence`}
        </span>
      </div>
      <p className="mt-3 max-w-[75ch] font-serif text-xl leading-snug sm:text-2xl">
        {withoutCitations(verdict)}
      </p>
      <Link
        href={`/trace/${runId}`}
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-lime underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none"
      >
        See how it was rated: every model, search and check
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </section>
  );
}
