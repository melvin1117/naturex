"use client";

import {
  Activity,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  ExternalLink,
  Gauge,
  type LucideIcon,
  Newspaper,
} from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  type AuditCase,
  type EvidenceRef,
  type Hypothesis,
  actorOf,
  modelLabel,
  seconds,
  withoutCitations,
} from "@/lib/trace-view";

import { ActorChip } from "./actor";

const ASSESSMENT: Record<
  Hypothesis["assessment"],
  { label: string; icon: LucideIcon; tone: string }
> = {
  supported: { label: "Supported", icon: CircleCheck, tone: "text-lime" },
  weakened: { label: "Weakened", icon: CircleMinus, tone: "text-clay" },
  unclear: { label: "Unclear", icon: CircleHelp, tone: "text-machine-muted" },
};

function refIcon(ref: EvidenceRef): LucideIcon {
  if (ref.kind === "news" || ref.kind === "evidence") return Newspaper;
  if (ref.id.startsWith("signal:")) return Activity;
  return Gauge;
}

/** One cited ID, resolved: a fact with its value, or a news report with its link. */
export function EvidenceChip({ evidence }: { evidence: EvidenceRef }) {
  const Icon = refIcon(evidence);
  const body = (
    <>
      <Icon
        className="mt-0.5 size-3.5 shrink-0 text-machine-muted"
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="line-clamp-2 block text-[13px] leading-snug text-machine-ink">
          {evidence.label}
        </span>
        {(evidence.value || evidence.date) && (
          <span className="block text-[11px] leading-snug text-machine-muted">
            {[evidence.date, evidence.value].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      {evidence.url && (
        <ExternalLink
          className="mt-0.5 size-3 shrink-0 text-machine-muted"
          aria-hidden="true"
        />
      )}
    </>
  );
  const shell = cn(
    "flex items-start gap-2 rounded-xl bg-machine px-2.5 py-2",
    evidence.direction === -1 && "ring-1 ring-clay/50 ring-inset",
    evidence.direction === 1 && "ring-1 ring-lime/40 ring-inset",
  );
  return evidence.url ? (
    <a
      href={evidence.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn(
        shell,
        "hover:bg-machine-line focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none",
      )}
    >
      {body}
      <span className="sr-only"> (opens the source in a new tab)</span>
    </a>
  ) : (
    <div className={shell} title={evidence.id}>
      {body}
    </div>
  );
}

function Scale({ c }: { c: AuditCase }) {
  // -10…+10 around a centre line; the bar runs from 0 to the adjustment.
  const at = (v: number) => `${((v + 10) / 20) * 100}%`;
  const lo = Math.min(0, c.adjustment);
  const hi = Math.max(0, c.adjustment);
  return (
    <div>
      <div className="relative h-2 rounded-full bg-machine" aria-hidden="true">
        <span className="absolute top-[-3px] left-1/2 h-3.5 w-px bg-machine-muted" />
        {c.adjustment !== 0 && (
          <span
            className={cn(
              "absolute top-0 h-2 rounded-full",
              c.adjustment < 0 ? "bg-clay" : "bg-lime",
            )}
            style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }}
          />
        )}
      </div>
      <div
        className="tabular mt-1 flex justify-between text-[10px] text-machine-muted"
        aria-hidden="true"
      >
        <span>−10</span>
        <span>0</span>
        <span>+10</span>
      </div>
    </div>
  );
}

/** The Auditor's case: what it weighed, what it concluded, and how far it moved health. */
export function TraceCase({ c }: { c: AuditCase }) {
  const [notes, setNotes] = useState(false);
  const fallback = c.source === "fallback";
  const adjustment =
    c.adjustment === 0
      ? "no change to health"
      : `${c.adjustment > 0 ? "+" : "−"}${Math.abs(c.adjustment)} health`;
  return (
    <div className="space-y-8">
      <section aria-labelledby="verdict-title">
        <div className="flex flex-wrap items-center gap-2">
          <ActorChip
            actor={fallback ? "code" : actorOf(c.model)}
            name={fallback ? "Formulas only" : modelLabel(c.model)}
            note={
              fallback
                ? "no model answer passed the checks"
                : c.reasoningTokens
                  ? `thought ${c.reasoningTokens.toLocaleString("en-US")} tokens${c.thinkMs ? ` in ${seconds(c.thinkMs)}` : ""}`
                  : null
            }
          />
          {c.source !== "ultra" && !fallback && (
            <span className="text-xs text-clay">
              Ultra was unavailable; a smaller model audited
            </span>
          )}
        </div>
        <h3 id="verdict-title" className="sr-only">
          Verdict
        </h3>
        <p className="mt-4 max-w-[68ch] font-serif text-2xl leading-snug text-machine-ink">
          {c.verdict
            ? withoutCitations(c.verdict)
            : fallback
              ? "No model answer passed the code checks, so the rating stands on the deterministic formulas alone."
              : "The Auditor found nothing that the formulas miss."}
        </p>
        <div className="mt-5 grid max-w-xl gap-2 sm:grid-cols-[1fr_auto] sm:items-end sm:gap-6">
          <Scale c={c} />
          <p className="tabular text-sm text-machine-ink">
            {c.baseHealth != null && c.health != null
              ? `${c.baseHealth.toFixed(1)} → ${c.health.toFixed(1)} · ${adjustment}`
              : adjustment}
          </p>
        </div>
        {c.adjustmentReason && (
          <p className="mt-2 max-w-[68ch] text-sm text-machine-muted">
            Why: {withoutCitations(c.adjustmentReason)}
          </p>
        )}
        <p className="mt-2 text-xs text-machine-muted">
          The Auditor may move health by at most 10 points, and only with cited
          evidence; code applies the change.
        </p>
      </section>

      {c.hypotheses.length > 0 && (
        <section aria-labelledby="weighed-title">
          <h3
            id="weighed-title"
            className="text-sm font-medium text-machine-ink"
          >
            The explanations it weighed
          </h3>
          <ol className="mt-3 grid gap-3 md:grid-cols-3">
            {c.hypotheses.map((h) => {
              const a = ASSESSMENT[h.assessment] ?? ASSESSMENT.unclear;
              return (
                <li
                  key={h.name}
                  className={cn(
                    "rounded-2xl bg-machine-raised p-4",
                    h.assessment === "supported" && "ring-1 ring-lime/50",
                  )}
                >
                  <p
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-medium",
                      a.tone,
                    )}
                  >
                    <a.icon className="size-3.5" aria-hidden="true" />
                    {a.label}
                  </p>
                  <p className="mt-1.5 text-[15px] leading-snug font-medium text-machine-ink">
                    {h.name}
                  </p>
                  <Refs title="For" refs={h.supporting} />
                  <Refs title="Against" refs={h.weakening} />
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {c.notes && (
        <section aria-labelledby="notes-title">
          <h3 id="notes-title" className="sr-only">
            The model&apos;s own notes
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNotes((n) => !n)}
            aria-expanded={notes}
            className="-ml-3 text-machine-muted hover:bg-machine-raised hover:text-machine-ink"
          >
            {notes ? "Hide" : "Show"} {modelLabel(c.model)}&apos;s own notes
          </Button>
          {notes && (
            <div className="mt-2 rounded-2xl bg-machine-raised p-4">
              <p className="text-xs text-machine-muted">
                The start of its working notes, as written. They are not
                evidence: only the case above, which code checked, counts.
              </p>
              <p className="machine-scroll mt-3 max-h-72 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-machine-ink/90">
                {c.notes}
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Refs({ title, refs }: { title: string; refs: EvidenceRef[] }) {
  if (!refs.length) return null;
  return (
    <div className="mt-3">
      <p className="text-[11px] text-machine-muted">{title}</p>
      <ul className="mt-1 space-y-1.5">
        {refs.map((ref) => (
          <li key={ref.id}>
            <EvidenceChip evidence={ref} />
          </li>
        ))}
      </ul>
    </div>
  );
}
