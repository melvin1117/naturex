"use client";

import { CornerDownRight } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import type { RunTrace } from "@/lib/api/types";
import { useShowCost } from "@/lib/hooks";
import type { BeforeAfterViews } from "@/lib/site-views";
import {
  ACTOR,
  type FlowNode,
  auditCase,
  auditChecks,
  newsFunnel,
  runFollowUps,
  runPlan,
  runSearches,
  runSignals,
  runVision,
  seconds,
  usd,
  withoutCitations,
} from "@/lib/trace-view";

import { Button } from "@/components/ui/button";

import { ActorChip, ActorIcon } from "./actor";
import { SiteVisionView } from "./site-vision";
import { FollowUpDetail, PlanDetail } from "./trace-followup";

const STATUS: Record<string, string> = {
  ok: "done",
  failed: "failed",
  skipped: "not run",
  rejected: "sent back",
  invalid_output: "invalid",
  error: "error",
  succeeded: "sealed",
  degraded: "sealed with a fallback",
};

function Meta({ node }: { node: FlowNode }) {
  const showCost = useShowCost();
  const parts = [
    node.latencyMs != null && node.latencyMs > 0
      ? seconds(node.latencyMs)
      : null,
    node.tokensIn + node.tokensOut > 0
      ? `${(node.tokensIn + node.tokensOut).toLocaleString("en-US")} tokens`
      : null,
    showCost && node.costUsd > 0 ? usd(node.costUsd, 5) : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <span className="tabular shrink-0 text-[11px] text-machine-muted">
      {parts.join(" · ")}
    </span>
  );
}

function NodeButton({
  node,
  selected,
  onSelect,
  small = false,
}: {
  node: FlowNode;
  selected: boolean;
  onSelect: (node: FlowNode) => void;
  small?: boolean;
}) {
  const muted = node.status === "skipped";
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onSelect(node)}
      aria-pressed={selected}
      className={cn(
        "h-auto w-full items-start justify-start gap-3 rounded-2xl px-3 py-2.5 text-left font-normal whitespace-normal active:translate-y-0",
        "text-machine-ink hover:bg-machine-raised hover:text-machine-ink focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none",
        selected && "bg-machine-raised ring-1 ring-lime/60",
        muted && "opacity-60",
      )}
    >
      <ActorIcon
        actor={node.actor}
        className={cn("relative z-10", small && "size-6")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span
            className={cn(
              "font-medium text-machine-ink",
              small ? "text-[13px]" : "text-sm",
            )}
          >
            {node.title}
          </span>
          <Meta node={node} />
        </span>
        <span className="mt-0.5 block text-xs text-machine-muted">
          {ACTOR[node.actor].name}
          {node.status !== "ok" && ` · ${STATUS[node.status] ?? node.status}`}
        </span>
        {node.summary && (
          <span
            className={cn(
              "mt-1 block text-[13px] leading-snug text-machine-ink/90",
              small && "line-clamp-2",
            )}
          >
            {node.summary}
          </span>
        )}
      </span>
    </Button>
  );
}

/** Required steps on a spine, Super's choice before each, and each step's branches. */
export function TraceFlow({
  trace,
  nodes,
  views,
}: {
  trace: RunTrace;
  nodes: FlowNode[];
  views?: BeforeAfterViews | null;
}) {
  const [selected, setSelected] = useState<FlowNode | null>(
    nodes.find((n) => n.step === "audit") ?? nodes[0] ?? null,
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
      <ol className="relative space-y-1" aria-label="The steps of this run">
        <span
          aria-hidden="true"
          className="absolute top-4 bottom-4 left-[26px] w-px bg-machine-line"
        />
        {nodes.map((node) => (
          <li key={node.id}>
            {node.decision && (
              <p className="relative ml-12 flex items-center gap-1.5 py-1 text-[11px] text-machine-muted">
                <CornerDownRight className="size-3" aria-hidden="true" />
                {node.decision.text}
                {node.decision.latencyMs != null &&
                  ` · ${seconds(node.decision.latencyMs)}`}
              </p>
            )}
            <NodeButton
              node={node}
              selected={selected?.id === node.id}
              onSelect={setSelected}
            />
            {node.children.length > 0 && (
              <ol
                className="relative mt-1 mb-2 ml-12 space-y-1 border-l border-machine-line/70 pl-3"
                aria-label={`${node.title}: details`}
              >
                {node.children.map((child) => (
                  <li key={child.id}>
                    <NodeButton
                      node={child}
                      selected={selected?.id === child.id}
                      onSelect={setSelected}
                      small
                    />
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
      <aside
        className="h-fit rounded-3xl bg-machine-raised p-5 lg:sticky lg:top-24"
        aria-label="Selected step"
        aria-live="polite"
      >
        {selected ? (
          <Inspector trace={trace} node={selected} views={views} />
        ) : (
          <p className="text-sm text-machine-muted">
            Choose a step to see what went in and what came out.
          </p>
        )}
      </aside>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-machine-muted">{label}</dt>
      <dd className="tabular text-right text-machine-ink">{value}</dd>
    </div>
  );
}

function Inspector({
  trace,
  node,
  views,
}: {
  trace: RunTrace;
  node: FlowNode;
  views?: BeforeAfterViews | null;
}) {
  const showCost = useShowCost();
  const step = node.step || node.id;
  return (
    <div>
      <ActorChip actor={node.actor} />
      <h3 className="mt-3 text-lg font-medium text-machine-ink">
        {node.title}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-machine-ink/90">
        {ACTOR[node.actor].role}.
      </p>
      <dl className="mt-4 divide-y divide-machine-line">
        <Row label="Status" value={STATUS[node.status] ?? node.status} />
        {node.latencyMs != null && node.latencyMs > 0 && (
          <Row label="Time" value={seconds(node.latencyMs)} />
        )}
        {node.tokensIn + node.tokensOut > 0 && (
          <Row
            label="Tokens"
            value={`${node.tokensIn.toLocaleString("en-US")} in · ${node.tokensOut.toLocaleString("en-US")} out`}
          />
        )}
        {showCost && node.costUsd > 0 && (
          <Row label="Cost" value={usd(node.costUsd, 5)} />
        )}
        {node.decision && <Row label="Chosen by" value={node.decision.text} />}
      </dl>
      <InspectorDetail trace={trace} node={node} step={step} views={views} />
    </div>
  );
}

function InspectorDetail({
  trace,
  node,
  step,
  views,
}: {
  trace: RunTrace;
  node: FlowNode;
  step: string;
  views?: BeforeAfterViews | null;
}) {
  const plan = node.id === "plan" ? runPlan(trace) : null;
  if (plan)
    return (
      <Section title="The plan">
        <PlanDetail plan={plan} />
      </Section>
    );
  const followUpIndex = /^investigate-(\d+)/.exec(node.id)?.[1];
  const followUp =
    followUpIndex == null ? null : runFollowUps(trace)[Number(followUpIndex)];
  if (followUp)
    return (
      <Section
        title={
          followUp.kind === "search" ? "The follow-up search" : "The article"
        }
      >
        <FollowUpDetail followUp={followUp} />
      </Section>
    );
  const vision = runVision(trace);
  if (node.id === "vision" && vision && !vision.error)
    return (
      <Section title="Five years apart">
        <SiteVisionView views={views} vision={vision} />
      </Section>
    );
  if (step === "earth_obs" || node.id.startsWith("signal-")) {
    const signals = runSignals(trace);
    return (
      <Section title="Dated signals found by code">
        {signals.length ? (
          <ul className="space-y-2">
            {signals.map((s) => (
              <li key={s.id} className="text-[13px] leading-snug">
                <span className="font-mono text-[11px] text-machine-muted">
                  {s.id}
                </span>
                <span className="block text-machine-ink">{s.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-machine-muted">No unusual month.</p>
        )}
        <p className="mt-3 text-xs text-machine-muted">
          Each month is compared with the same month in the other years, so a
          normal dry season is not a signal.
        </p>
      </Section>
    );
  }
  if (step === "news" || node.id.startsWith("search-")) {
    const searches = runSearches(trace);
    return (
      <Section title="Tavily searches">
        <ul className="space-y-2">
          {searches.map((s) => (
            <li key={s.query} className="text-[13px] leading-snug">
              <span className="block text-machine-ink">“{s.query}”</span>
              <span className="tabular text-xs text-machine-muted">
                {s.language && s.language !== "en" ? `${s.language} · ` : ""}
                {s.error ? "failed" : `${s.results} results`} ·{" "}
                {seconds(s.latencyMs)} · {s.credits} credits
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-machine-muted">
          Queries are written by code from the site&apos;s name, region and
          ecosystem, in English and the local language. Article text is treated
          as untrusted data.
        </p>
      </Section>
    );
  }
  if (node.id.startsWith("classify-") || node.id === "place-check") {
    const funnel = newsFunnel(trace) ?? [];
    return (
      <Section title="What survived each check">
        <ul className="space-y-1.5">
          {funnel.map((s) => (
            <li key={s.label} className="flex justify-between text-[13px]">
              <span className="text-machine-muted">{s.label}</span>
              <span className="tabular text-machine-ink">{s.count}</span>
            </li>
          ))}
        </ul>
      </Section>
    );
  }
  if (
    step === "audit" ||
    node.id.startsWith("audit-") ||
    node.id === "claim-check"
  ) {
    const c = auditCase(trace);
    const checks = auditChecks(trace);
    return (
      <Section title="The case">
        {c?.verdict && (
          <p className="text-[13px] leading-relaxed text-machine-ink">
            {withoutCitations(c.verdict)}
          </p>
        )}
        {checks && (
          <ul className="mt-3 space-y-1 text-xs text-machine-muted">
            <li>
              {checks.resolved} of {checks.citations} citations point to real
              evidence
            </li>
            <li>{checks.placeholders} numbers filled in by code</li>
            <li>
              {checks.refused} answer{checks.refused === 1 ? "" : "s"} sent back
            </li>
          </ul>
        )}
        <p className="mt-3 text-xs text-machine-muted">
          The Reasoning tab shows each explanation it weighed and the evidence
          for and against.
        </p>
      </Section>
    );
  }
  if (step === "valuation") {
    const o = (trace.steps.find((s) => s.step === "valuation")?.output ??
      {}) as Record<string, unknown>;
    return (
      <Section title="Computed by code">
        <dl className="divide-y divide-machine-line">
          <Row
            label="Value, low–high"
            value={`$${Number(o.value_low).toLocaleString("en-US")}–$${Number(o.value_high).toLocaleString("en-US")} / yr`}
          />
          <Row
            label="Carbon stock"
            value={`${Number(o.carbon_stock_tco2).toLocaleString("en-US")} tCO2`}
          />
        </dl>
      </Section>
    );
  }
  if (step === "done")
    return (
      <Section title="Sealed">
        <p className="text-[13px] leading-relaxed text-machine-ink/90">
          The report, its evidence and this run&apos;s record are appended to
          the hash-chained Record, so any later change would break the chain.
        </p>
      </Section>
    );
  return null;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 border-t border-machine-line pt-4">
      <h4 className="mb-2 text-xs font-medium text-machine-muted">{title}</h4>
      {children}
    </section>
  );
}
