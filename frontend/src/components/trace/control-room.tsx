"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { cn } from "cn";

import { TraceError } from "@/components/agent-trace";
import { MachineRowsSkeleton } from "@/components/page-skeletons";
import {
  type Gauges,
  type ModelRow,
  gauges,
  modelRows,
} from "@/lib/control-room";
import { useAiUsage, useShowCost, useWorld } from "@/lib/hooks";
import { ACTOR, seconds, usd } from "@/lib/trace-view";

import { ActorIcon } from "./actor";
import { EvalResults } from "./eval-results";

function Meter({
  value,
  label,
  tone = "lime",
}: {
  value: number;
  label: string;
  tone?: "lime" | "clay";
}) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="mt-3 h-2 overflow-hidden rounded-full bg-machine"
    >
      <span
        className={cn(
          "block h-full rounded-full",
          tone === "lime" ? "bg-lime" : "bg-clay",
        )}
        style={{ width: `${Math.max(1.5, value * 100)}%` }}
      />
    </div>
  );
}

function GaugeRow({
  g,
  scope,
  showCost,
}: {
  g: Gauges;
  scope: string;
  showCost: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        showCost ? "sm:grid-cols-3" : "sm:grid-cols-2",
      )}
    >
      {showCost && (
        <section className="rounded-3xl bg-machine-raised p-5">
          <h2 className="text-sm text-machine-muted">
            Model spend, whole demo
          </h2>
          <p className="tabular mt-1 text-2xl text-machine-ink">
            {usd(g.spentUsd, 2)}
            <span className="text-base text-machine-muted">
              {" "}
              of a {usd(g.budgetUsd, 0)} cap
            </span>
          </p>
          <Meter
            value={g.spent}
            label="Share of the model budget spent"
            tone={g.spent > 0.8 ? "clay" : "lime"}
          />
          <p className="mt-2 text-xs text-machine-muted">
            Every visitor together. At the cap, live steps stop and cached
            results show instead.
          </p>
        </section>
      )}
      <section className="rounded-3xl bg-machine-raised p-5">
        <h2 className="text-sm text-machine-muted">{scope}</h2>
        <p className="tabular mt-1 text-2xl text-machine-ink">
          {g.calls.toLocaleString("en-US")}
          <span className="text-base text-machine-muted"> model calls</span>
        </p>
        <p className="tabular mt-1 text-sm text-machine-ink/90">
          {showCost && `${usd(g.worldUsd, 3)} · `}
          {g.sentBack === 0
            ? "no answer sent back"
            : `${g.sentBack} answer${g.sentBack === 1 ? "" : "s"} sent back by code`}
        </p>
        <p className="mt-2 text-xs text-machine-muted">
          A model answer that fails code&apos;s checks is refused and asked
          again; those refusals are counted, not hidden.
        </p>
      </section>
      <section className="rounded-3xl bg-machine-raised p-5">
        <h2 className="text-sm text-machine-muted">Tavily credits left</h2>
        <p className="tabular mt-1 text-2xl text-machine-ink">
          {g.tavilyLeft == null ? "—" : g.tavilyLeft.toLocaleString("en-US")}
        </p>
        <p className="mt-2 text-xs text-machine-muted">
          {g.tavilyLeft == null
            ? "Unknown here (mock mode or no key)."
            : `News searches pause below ${g.tavilyFloor.toLocaleString("en-US")}, so the demo never runs the account dry. Each search costs 2 credits; reading 5 articles costs 1.`}
        </p>
      </section>
    </div>
  );
}

function Outcomes({ row }: { row: ModelRow }) {
  const o = row.outcomes;
  const parts = [
    { key: "ok", value: o.ok, className: "bg-lime" },
    { key: "rejected", value: o.rejected, className: "bg-clay" },
    { key: "invalid", value: o.invalid, className: "bg-[var(--grade-b)]" },
    { key: "errors", value: o.errors, className: "bg-machine-muted" },
  ].filter((p) => p.value > 0);
  const s = row.stats;
  if (!s) return null;
  return (
    <div>
      <div
        className="flex h-1.5 overflow-hidden rounded-full bg-machine"
        aria-hidden="true"
      >
        {parts.map((p) => (
          <span
            key={p.key}
            className={p.className}
            style={{ width: `${p.value * 100}%` }}
          />
        ))}
      </div>
      <p className="tabular mt-1.5 text-xs text-machine-muted">
        {s.ok} accepted
        {s.rejected > 0 && ` · ${s.rejected} sent back by code`}
        {s.invalid > 0 && ` · ${s.invalid} broken JSON`}
        {s.errors > 0 && ` · ${s.errors} errors`}
      </p>
    </div>
  );
}

function ModelCard({ row, showCost }: { row: ModelRow; showCost: boolean }) {
  const s = row.stats;
  return (
    <li className="grid gap-4 rounded-3xl bg-machine-raised p-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <ActorIcon actor={row.actor} />
          <div className="min-w-0">
            <h3 className="text-base font-medium text-machine-ink">
              {row.name}
            </h3>
            <p className="truncate font-mono text-[11px] text-machine-muted">
              {row.model}
            </p>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-machine-ink/90">
          {row.jobs}.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-machine-muted">
          Why this model: {row.why}. {row.reasoning}.
          {showCost &&
            row.price[0] > 0 &&
            ` $${row.price[0]} in / $${row.price[1]} out per 1M tokens.`}
        </p>
      </div>
      {s ? (
        <div className="min-w-0 space-y-3">
          <dl
            className={cn(
              "tabular grid gap-3 text-sm",
              showCost ? "grid-cols-3" : "grid-cols-2",
            )}
          >
            <div>
              <dt className="text-xs text-machine-muted">Calls</dt>
              <dd className="text-machine-ink">{s.calls}</dd>
            </div>
            <div>
              <dt className="text-xs text-machine-muted">Typical · slow</dt>
              <dd className="text-machine-ink">
                {s.p50_latency_ms == null ? "—" : seconds(s.p50_latency_ms)}
                <span className="text-machine-muted">
                  {" "}
                  · {s.p95_latency_ms == null ? "—" : seconds(s.p95_latency_ms)}
                </span>
              </dd>
            </div>
            {showCost && (
              <div>
                <dt className="text-xs text-machine-muted">Cost</dt>
                <dd className="text-machine-ink">
                  {usd(Number(s.cost_usd), 4)}
                  {row.share > 0 && (
                    <span className="text-machine-muted">
                      {" "}
                      · {Math.round(row.share * 100)}%
                    </span>
                  )}
                </dd>
              </div>
            )}
          </dl>
          <p className="tabular text-xs text-machine-muted">
            {s.prompt_tokens.toLocaleString("en-US")} tokens in ·{" "}
            {s.completion_tokens.toLocaleString("en-US")} out
          </p>
          <Outcomes row={row} />
        </div>
      ) : (
        <p className="self-center text-sm text-machine-muted">
          No calls here yet.
        </p>
      )}
    </li>
  );
}

/** `/ai`: which model does which job and why, with this world's live calls, the deployment's
 * spend against its cap and the Tavily credits left. Reads `GET /admin/ai-usage`. */
export function ControlRoom() {
  const usage = useAiUsage();
  const showCost = useShowCost();
  // Sandboxes carry the demo personas; the live world has none.
  const sandbox = (useWorld().world?.personas.length ?? 0) > 0;
  const scope = sandbox ? "Your demo" : "The live market";
  const rows = useMemo(() => modelRows(usage.data), [usage.data]);
  const g = useMemo(() => gauges(usage.data), [usage.data]);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="font-serif text-4xl leading-tight text-foreground">
        The AI at work
      </h1>
      <p className="mt-2 max-w-[65ch] text-muted-foreground">
        Each job goes to the model that suits it, every call goes through Nebius
        Token Factory, and every answer is checked by code before it counts.
      </p>
      <div className="mt-6 space-y-6 rounded-[28px] bg-machine p-5 text-machine-ink sm:p-8">
        {!usage.data && usage.error ? (
          <TraceError
            title="We couldn't load the model usage"
            error={usage.error}
            retry={usage.refetch}
          />
        ) : !usage.data ? (
          <MachineRowsSkeleton label="Loading the model usage…" />
        ) : (
          <>
            <GaugeRow g={g} scope={scope} showCost={showCost} />
            {g.calls === 0 && (
              <p className="rounded-2xl bg-machine-raised px-5 py-4 text-sm text-machine-ink/90">
                Nothing has run here yet. Rate a site (the tour&apos;s third
                chapter, or <strong>Rate</strong> on a listing) and the
                models&apos; calls appear here as they happen. Each demo site
                also shows a recorded run you can open for free from its page.
              </p>
            )}
            <section aria-labelledby="routing-title">
              <h2
                id="routing-title"
                className="text-lg font-medium text-machine-ink"
              >
                Who does what, and how it went
              </h2>
              <ul className="mt-3 space-y-3">
                {rows.map((row) => (
                  <ModelCard key={row.model} row={row} showCost={showCost} />
                ))}
                <li className="grid gap-4 rounded-3xl bg-machine-raised p-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                  <div className="flex items-start gap-3">
                    <ActorIcon actor="tavily" />
                    <div>
                      <h3 className="text-base font-medium text-machine-ink">
                        {ACTOR.tavily.name}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-machine-ink/90">
                        Searches local news in English and the local language
                        (Search), and opens the articles Super wants checked
                        (Extract, ranked by its question).
                      </p>
                    </div>
                  </div>
                  <p className="self-center text-xs leading-relaxed text-machine-muted">
                    Queries are written by code from the site, its ecosystem and
                    the dated satellite signals, never by a model. Results are
                    untrusted: injected instructions are cut and every item must
                    name the place.
                  </p>
                </li>
              </ul>
            </section>
            <EvalResults />
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-lime underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none"
            >
              Open a site and its &ldquo;How the AI rated it&rdquo; trace to see
              one run step by step
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
