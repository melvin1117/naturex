import { CircleCheck, Hash, Undo2 } from "lucide-react";

import type { AuditChecks, FunnelStage } from "@/lib/trace-view";

import { ActorIcon } from "./actor";

/** What code checked: how the news narrowed, and how every claim of the audit was verified. */
export function TraceChecks({
  funnel,
  checks,
}: {
  funnel: FunnelStage[] | null;
  checks: AuditChecks | null;
}) {
  const top = Math.max(1, ...(funnel ?? []).map((s) => s.count));
  return (
    <div className="grid gap-10 lg:grid-cols-2">
      <section aria-labelledby="funnel-title">
        <h3
          id="funnel-title"
          className="flex items-center gap-2 text-sm font-medium text-machine-ink"
        >
          <ActorIcon actor="tavily" className="size-5" />
          From web results to news about this site
        </h3>
        {funnel ? (
          <ol className="mt-4 space-y-3">
            {funnel.map((stage, i) => (
              <li key={stage.label}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-machine-ink">{stage.label}</span>
                  <span className="tabular text-machine-ink">
                    {stage.count}
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-machine-raised">
                  <div
                    className={
                      i < 2
                        ? "h-2 rounded-full bg-sky"
                        : i < 5
                          ? "h-2 rounded-full bg-lime/70"
                          : "h-2 rounded-full bg-lime"
                    }
                    style={{ width: `${(stage.count / top) * 100}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-machine-muted">{stage.note}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-sm text-machine-muted">
            This run has no news search to show (sample news, or news was
            paused).
          </p>
        )}
      </section>

      <section aria-labelledby="claims-title">
        <h3
          id="claims-title"
          className="flex items-center gap-2 text-sm font-medium text-machine-ink"
        >
          <ActorIcon actor="code" className="size-5" />
          Every claim of the audit, checked by code
        </h3>
        {checks ? (
          <>
            <ul className="mt-4 space-y-3 text-sm text-machine-ink">
              <li className="flex gap-2.5">
                <CircleCheck
                  className="mt-0.5 size-4 shrink-0 text-lime"
                  aria-hidden="true"
                />
                <span>
                  <span className="tabular">
                    {checks.resolved} of {checks.citations}
                  </span>{" "}
                  citations point to a real fact or news item; an unknown one is
                  refused.
                </span>
              </li>
              <li className="flex gap-2.5">
                <Hash
                  className="mt-0.5 size-4 shrink-0 text-lime"
                  aria-hidden="true"
                />
                <span>
                  <span className="tabular">{checks.placeholders}</span> number
                  {checks.placeholders === 1 ? "" : "s"} in the report were
                  written as placeholders and filled in by code with the exact
                  computed value.
                </span>
              </li>
              <li className="flex gap-2.5">
                <Undo2
                  className="mt-0.5 size-4 shrink-0 text-clay"
                  aria-hidden="true"
                />
                <span>
                  <span className="tabular">{checks.refused}</span> answer
                  {checks.refused === 1 ? " was" : "s were"} sent back
                  {checks.rounds > 1 ? ` (${checks.rounds} rounds in all)` : ""}
                  .
                </span>
              </li>
            </ul>
            {checks.rejections.length > 0 && (
              <div className="mt-5 rounded-2xl bg-machine-raised p-4">
                <p className="text-xs text-machine-muted">
                  Why an answer was sent back
                </p>
                <ul className="mt-2 space-y-1.5 text-[13px] leading-snug text-machine-ink/90">
                  {checks.rejections.map((r) => (
                    <li key={r} className="break-words">
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-5 text-xs leading-relaxed text-machine-muted">
              Models may only cite and explain. Prices, scores and values come
              from tested formulas, and nothing a model writes reaches you
              unchecked.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm text-machine-muted">
            No audit ran in this run.
          </p>
        )}
      </section>
    </div>
  );
}
