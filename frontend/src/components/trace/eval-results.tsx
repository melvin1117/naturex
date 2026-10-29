"use client";

import { useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { EVALS, NEWS_TIER } from "@/lib/evals";
import { useShowCost } from "@/lib/hooks";
import { seconds, usd } from "@/lib/trace-view";

const TIER: Record<string, string> = {
  nano: "Nemotron 3 Nano",
  super: "Nemotron 3 Super",
  ultra: "Nemotron 3 Ultra",
};

function Failures({
  label,
  items,
}: {
  label: string;
  items: React.ReactNode[];
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="-ml-3 text-machine-muted hover:bg-machine hover:text-machine-ink"
      >
        {open ? "Hide" : "Show"} {label}
      </Button>
      {open && (
        <ul className="mt-2 space-y-1.5 text-[13px] leading-snug text-machine-ink/90">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewsEval({ showCost }: { showCost: boolean }) {
  const { items, rows } = EVALS.news;
  return (
    <section className="rounded-3xl bg-machine-raised p-5">
      <h3 className="text-base font-medium text-machine-ink">
        Which model sorts the news
      </h3>
      <p className="mt-1 max-w-[70ch] text-sm text-machine-muted">
        {items} hand-labelled local news items (relevance, impact, direction,
        severity, plus planted prompt injections) through the real News Scout
        code on each tier. Super matched Ultra within one item
        {showCost && " at under a third of the cost"} and no slower, so
        production sends the news to Super.
      </p>
      <div className="machine-scroll mt-4 overflow-x-auto">
        <table className="tabular w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs text-machine-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">Model</th>
              <th className="py-2 pr-3 font-medium">All labels right</th>
              <th className="py-2 pr-3 font-medium">Relevance</th>
              <th className="py-2 pr-3 font-medium">Impact type</th>
              <th className="py-2 pr-3 font-medium">Injections</th>
              <th className="py-2 pr-3 font-medium">Typical time</th>
              {showCost && (
                <th className="py-2 font-medium">Cost, {items} items</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-machine-line">
            {rows.map((r) => (
              <tr
                key={r.tier}
                className={cn(r.tier === NEWS_TIER && "text-lime")}
              >
                <td className="py-2.5 pr-3">
                  {TIER[r.tier] ?? r.tier}
                  {r.tier === NEWS_TIER && (
                    <span className="ml-2 text-xs text-machine-muted">
                      in use
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-3">
                  {r.passed}/{r.tests}
                </td>
                <td className="py-2.5 pr-3">{r.metrics.relevance ?? "—"}</td>
                <td className="py-2.5 pr-3">{r.metrics.impact_type ?? "—"}</td>
                <td className="py-2.5 pr-3">
                  {r.metrics.injection_resistance ?? "—"}
                </td>
                <td className="py-2.5 pr-3">
                  {r.p50_latency_ms == null ? "—" : seconds(r.p50_latency_ms)}
                </td>
                {showCost && <td className="py-2.5">{usd(r.cost_usd, 4)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Failures
        label="where each model went wrong"
        items={rows.flatMap((r) =>
          r.failures.map((f) => (
            <span key={`${r.tier}-${f}`}>
              <span className="text-machine-muted">{TIER[r.tier]}:</span> {f}
            </span>
          )),
        )}
      />
    </section>
  );
}

function AuditorEval({ showCost }: { showCost: boolean }) {
  const { summary: s, failures, run_on } = EVALS.auditor;
  const stats: [string, string][] = [
    ["First answer accepted", `${s.first_answer_accepted}/${s.cases}`],
    ["Finished by Ultra", `${s.ended_on_ultra}/${s.cases}`],
    ["Cites the news it weighed", s.cites_the_event],
    [
      "Never moved against the evidence",
      `${s.direction_consistent}/${s.cases}`,
    ],
    ["Ignored planted instructions", s.injection_resisted],
    [
      "Typical time · thinking",
      `${s.p50_latency_ms == null ? "—" : seconds(s.p50_latency_ms)} · ${s.median_reasoning_tokens?.toLocaleString("en-US") ?? "—"} tokens`,
    ],
  ];
  if (showCost)
    stats.push([
      "Cost per audit",
      s.cost_per_case_usd == null ? "—" : usd(s.cost_per_case_usd, 3),
    ]);
  return (
    <section className="rounded-3xl bg-machine-raised p-5">
      <h3 className="text-base font-medium text-machine-ink">
        The Auditor under pressure
      </h3>
      <p className="mt-1 max-w-[70ch] text-sm text-machine-muted">
        Nemotron 3 Ultra, thinking on, judged {s.cases} cases: each demo
        site&apos;s real satellite record with no news, with fire, encroachment
        or restoration news, and with a news item that orders it to raise the
        score. Code checked every answer ({run_on}).
      </p>
      <dl className="tabular mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-machine-muted">{label}</dt>
            <dd className="text-lg text-machine-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <Failures
        label={`the ${failures.length} answers code sent back`}
        items={failures.map((f) => (
          <span key={f.case}>
            <span className="text-machine-muted">{f.case}:</span>{" "}
            {f.refused[0] ?? f.what}
            {f.recovered && (
              <span className="text-machine-muted">
                {" "}
                — fixed by Ultra in the next round
              </span>
            )}
          </span>
        ))}
      />
    </section>
  );
}

/** Agent names in `llm_calls`, as a reader would say them. */
const AGENT: Record<string, string> = {
  orchestrator: "Orchestrator (Super)",
  news_scout: "News Scout (Super)",
  article_reader: "Article reader (Nano)",
  auditor: "Auditor (Ultra)",
  site_vision: "Satellite views (Super VL)",
  copilot: "Bea (Nano)",
  copilot_embed: "Bea's search (Qwen3 embeddings)",
  report_summary: "Report summary",
};

function CopilotEval({ showCost }: { showCost: boolean }) {
  const { summary: s, failures, run_on } = EVALS.copilot;
  const stats: [string, string][] = [
    ["Grounded, every check", `${s.grounded}/${s.items}`],
    ["Answers or refuses rightly", s.right_behaviour],
    ["Cites the right source", s.cites_expected],
    ["Every number from what it cites", s.numbers_in_cited],
    ["Ignored planted instructions", s.injection_and_tone],
    ["First draft accepted", s.first_try],
    [
      "Typical time",
      s.p50_latency_ms == null ? "—" : seconds(s.p50_latency_ms),
    ],
  ];
  if (showCost) stats.push([`Cost, ${s.items} questions`, usd(s.cost_usd, 3)]);
  return (
    <section className="rounded-3xl bg-machine-raised p-5">
      <h3 className="text-base font-medium text-machine-ink">
        Bea sticks to the Record
      </h3>
      <p className="mt-1 max-w-[70ch] text-sm text-machine-muted">
        {s.items} questions about the demo sites through Bea&apos;s real answer
        path on Nemotron 3 Nano: grades, values, news, comparisons, questions
        the Record can&apos;t answer, and a news item that tells her to inflate
        the value. Code checked every citation and number ({run_on}).
      </p>
      <dl className="tabular mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-machine-muted">{label}</dt>
            <dd className="text-lg text-machine-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <Failures
        label={`the ${failures.length} answers that missed`}
        items={failures.map((f) => (
          <span key={f.id}>
            <span className="text-machine-muted">{f.question}</span> {f.what}
          </span>
        ))}
      />
    </section>
  );
}

function SchemaEval() {
  const { agents, total, run_on } = EVALS.schema;
  const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
  return (
    <section className="rounded-3xl bg-machine-raised p-5">
      <h3 className="text-base font-medium text-machine-ink">
        Every agent answers in the expected shape
      </h3>
      <p className="mt-1 max-w-[70ch] text-sm text-machine-muted">
        Every model call logged so far ({total.attempts.toLocaleString("en-US")}{" "}
        attempts to {run_on}): how often the reply validated against its schema
        on the first try, and how often a valid reply was still sent back by a
        code check.
      </p>
      <div className="machine-scroll mt-4 overflow-x-auto">
        <table className="tabular w-full min-w-[480px] text-sm">
          <thead className="text-left text-xs text-machine-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">Agent</th>
              <th className="py-2 pr-3 font-medium">Attempts</th>
              <th className="py-2 pr-3 font-medium">Valid shape</th>
              <th className="py-2 font-medium">Sent back by code</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-machine-line">
            {agents.map((r) => (
              <tr key={r.agent}>
                <td className="py-2.5 pr-3">{AGENT[r.agent] ?? r.agent}</td>
                <td className="py-2.5 pr-3">{r.attempts}</td>
                <td className="py-2.5 pr-3">{pct(r.schema_valid_pct)}</td>
                <td className="py-2.5">{pct(r.refused_pct)}</td>
              </tr>
            ))}
            <tr className="text-lime">
              <td className="py-2.5 pr-3">All agents</td>
              <td className="py-2.5 pr-3">{total.attempts}</td>
              <td className="py-2.5 pr-3">{pct(total.schema_valid_pct)}</td>
              <td className="py-2.5">{pct(total.refused_pct)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The published evals, failures included (`evals/results`, ADR-0003). */
export function EvalResults() {
  const showCost = useShowCost();
  return (
    <section aria-labelledby="evals-title" className="space-y-3">
      <h2 id="evals-title" className="text-lg font-medium text-machine-ink">
        How we chose, and where it fails
      </h2>
      <NewsEval showCost={showCost} />
      <AuditorEval showCost={showCost} />
      <CopilotEval showCost={showCost} />
      <SchemaEval />
    </section>
  );
}
