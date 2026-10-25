import { PanelRight } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import type { RecordedRun, ReportOut, RunTrace } from "@/lib/api/types";
import { date } from "@/lib/prototype/format";
import {
  auditCase,
  costReceipt,
  modelLabel,
  withoutCitations,
} from "@/lib/trace-view";

import { ActorChip } from "./actor";

const AUDITOR_MODEL = "nvidia/Nemotron-3-Ultra-550b-a55b";

/**
 * Under a site's header: the Auditor's verdict in one line, the models that worked on it (from
 * the run's own receipt) and the way into the Agent Trace, which opens over the page. The site's
 * own rated report wins; a demo site nobody has rated in this sandbox shows its recorded run,
 * labelled with its date and as not the source of the page's rating.
 */
export function VerdictStrip({
  report,
  recorded,
  trace,
  onOpen,
}: {
  report: ReportOut | null | undefined;
  recorded?: RecordedRun | null;
  /** The run behind the verdict, once loaded: who worked on it. */
  trace?: RunTrace | null;
  onOpen: () => void;
}) {
  const own = report?.auditor?.verdict && report?.run_id ? report : null;
  // A recording stands in only while the site has no rated run of its own.
  const recordedCase =
    !report?.run_id && recorded ? auditCase(recorded.trace) : null;
  const verdict = own?.auditor?.verdict ?? recordedCase?.verdict;
  const crew = useMemo(() => (trace ? crewOf(trace) : []), [trace]);
  // Who judged it, from the run when it's here; the Auditor's model otherwise.
  const judge = useMemo(() => {
    const model = (trace ? auditCase(trace) : null)?.model;
    return model ? modelLabel(model) : modelLabel(AUDITOR_MODEL);
  }, [trace]);
  if (!verdict) return null;
  const adjustment = own
    ? (own.auditor?.auditor_adjustment ?? 0)
    : (recordedCase?.adjustment ?? 0);
  return (
    <section
      aria-label="How it was rated"
      className="mt-6 rounded-[1.75rem] bg-machine px-6 py-6 text-machine-ink sm:px-8 sm:py-7"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ActorChip
          actor="ultra"
          name={`Judged by ${judge}`}
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
      <p className="mt-4 max-w-[62ch] font-serif text-xl leading-snug text-balance sm:text-[1.65rem]">
        {withoutCitations(verdict)}
      </p>
      {recordedCase && (
        <p className="mt-2 max-w-[62ch] text-sm text-machine-muted">
          A real run of this site, recorded to show the agents at work. The
          rating on this page comes from the formula alone.
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        {crew.length > 0 ? (
          <ul aria-label="Who worked on it" className="flex flex-wrap gap-1.5">
            {crew.map((c) => (
              <li key={c.key}>
                <ActorChip actor={c.actor} name={c.name} note={c.note} />
              </li>
            ))}
          </ul>
        ) : null}
        <Button
          variant="on-image"
          aria-haspopup="dialog"
          onClick={onOpen}
          className="ml-auto focus-visible:ring-card focus-visible:ring-offset-2 focus-visible:ring-offset-machine"
        >
          <PanelRight aria-hidden="true" />
          Open the Agent Trace
        </Button>
      </div>
    </section>
  );
}

type CrewMember = {
  key: string;
  actor: Parameters<typeof ActorChip>[0]["actor"];
  name: string;
  note: string;
};

/** The run's models by how many calls they made, then its web searches. */
function crewOf(trace: RunTrace): CrewMember[] {
  const receipt = costReceipt(trace);
  const models = [...receipt.models]
    .sort((a, b) => b.calls - a.calls)
    .map<CrewMember>((m) => ({
      key: m.model,
      actor: m.actor,
      name: m.name,
      note: `${m.calls} call${m.calls === 1 ? "" : "s"}`,
    }));
  const searches: CrewMember[] =
    receipt.searches > 0
      ? [
          {
            key: "tavily",
            actor: "tavily",
            name: "Tavily",
            note: `${receipt.searches} search${receipt.searches === 1 ? "" : "es"}`,
          },
        ]
      : [];
  return [...models, ...searches];
}
