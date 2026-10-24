import { ArrowRight } from "lucide-react";
import Link from "@/components/app-link";

import type { RecordedRun, ReportOut } from "@/lib/api/types";
import { date } from "@/lib/prototype/format";
import { auditCase, modelLabel, withoutCitations } from "@/lib/trace-view";

import { ActorChip } from "./actor";

/** Under a site's header: the Auditor's verdict in one line, who judged it, and the way to
 * the full trace. The site's own rated report wins; a demo site nobody has rated in this world
 * shows its recorded run instead, labelled with its date. */
export function VerdictStrip({
  report,
  recorded,
  assetId,
}: {
  report: ReportOut | null | undefined;
  recorded?: RecordedRun | null;
  assetId?: string;
}) {
  const own = report?.auditor?.verdict && report?.run_id ? report : null;
  // A recording stands in only while the site has no rated run of its own.
  const recordedCase =
    !report?.run_id && recorded && assetId ? auditCase(recorded.trace) : null;
  const verdict = own?.auditor?.verdict ?? recordedCase?.verdict;
  if (!verdict) return null;
  const adjustment = own
    ? (own.auditor?.auditor_adjustment ?? 0)
    : (recordedCase?.adjustment ?? 0);
  const href = own ? `/trace/${own.run_id}` : `/trace/recorded/${assetId}`;
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
          {recordedCase && recorded
            ? `A recorded run, ${date(recorded.recorded_on)} · `
            : ""}
          {adjustment === 0
            ? "No change to the formula's health"
            : `Health ${adjustment > 0 ? "+" : "−"}${Math.abs(adjustment)} with cited evidence`}
        </span>
      </div>
      <p className="mt-3 max-w-[75ch] font-serif text-xl leading-snug sm:text-2xl">
        {withoutCitations(verdict)}
      </p>
      {recordedCase && (
        <p className="mt-2 max-w-[75ch] text-sm text-machine-muted">
          A real run of this site with the live models, recorded so you can see
          them at work for free. The report below is the formula&apos;s; rate
          the site to run the agents yourself.
        </p>
      )}
      <Link
        href={href}
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-lime underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none"
      >
        See how it was rated: every model, search and check
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </section>
  );
}
