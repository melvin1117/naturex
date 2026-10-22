import { cn } from "cn";

import { type Receipt, modelLabel, seconds, usd } from "@/lib/trace-view";

import { ACTOR_FILL, ActorChip } from "./actor";

/** The routing receipt: what each model cost, and what Ultra alone would have cost. */
export function TraceCost({ receipt }: { receipt: Receipt }) {
  const top = Math.max(receipt.totalUsd, receipt.baselineUsd ?? 0, 1e-9);
  return (
    <div className="space-y-8">
      <section aria-labelledby="receipt-title">
        <h3
          id="receipt-title"
          className="max-w-[60ch] text-base text-machine-ink"
        >
          This rating cost{" "}
          <span className="tabular font-medium">{usd(receipt.totalUsd)}</span>{" "}
          in model calls
          {receipt.baselineUsd != null && (
            <>
              . The same tokens on {modelLabel(receipt.baselineModel)} alone
              would cost{" "}
              <span className="tabular font-medium">
                {usd(receipt.baselineUsd)}
              </span>
              {receipt.savedPct ? `: routing saves ${receipt.savedPct}%` : ""}
            </>
          )}
          .
        </h3>
        <dl className="mt-4 max-w-xl space-y-2">
          <div>
            <dt className="text-xs text-machine-muted">Routed by task</dt>
            <dd className="mt-1 flex h-3 overflow-hidden rounded-full bg-machine-raised">
              {receipt.models.map((m) => (
                <span
                  key={m.model}
                  className={cn("h-3", ACTOR_FILL[m.actor].split(" ")[0])}
                  style={{ width: `${(m.costUsd / top) * 100}%` }}
                  title={`${m.name}: ${usd(m.costUsd, 5)}`}
                />
              ))}
            </dd>
          </div>
          {receipt.baselineUsd != null && (
            <div>
              <dt className="text-xs text-machine-muted">
                Everything on {modelLabel(receipt.baselineModel)}
              </dt>
              <dd className="mt-1 flex h-3 overflow-hidden rounded-full bg-machine-raised">
                <span
                  className="h-3 bg-machine-muted/60"
                  style={{ width: `${(receipt.baselineUsd / top) * 100}%` }}
                />
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section aria-labelledby="per-model-title">
        <h3
          id="per-model-title"
          className="text-sm font-medium text-machine-ink"
        >
          Who did the work
        </h3>
        <div className="machine-scroll mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs text-machine-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Model or service</th>
                <th className="py-2 pr-3 text-right font-medium">Calls</th>
                <th className="py-2 pr-3 text-right font-medium">
                  Tokens in · out
                </th>
                <th className="py-2 pr-3 text-right font-medium">Time</th>
                <th className="py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="tabular divide-y divide-machine-line">
              {receipt.models.map((m) => (
                <tr key={m.model}>
                  <td className="py-2.5 pr-3">
                    <ActorChip actor={m.actor} name={m.name} />
                  </td>
                  <td className="py-2.5 pr-3 text-right">{m.calls}</td>
                  <td className="py-2.5 pr-3 text-right">
                    {m.tokensIn.toLocaleString("en-US")} ·{" "}
                    {m.tokensOut.toLocaleString("en-US")}
                  </td>
                  <td className="py-2.5 pr-3 text-right">
                    {seconds(m.latencyMs)}
                  </td>
                  <td className="py-2.5 text-right">{usd(m.costUsd, 5)}</td>
                </tr>
              ))}
              {receipt.searches > 0 && (
                <tr>
                  <td className="py-2.5 pr-3">
                    <ActorChip actor="tavily" />
                  </td>
                  <td className="py-2.5 pr-3 text-right">{receipt.searches}</td>
                  <td className="py-2.5 pr-3 text-right text-machine-muted">
                    {receipt.credits} credits
                  </td>
                  <td className="py-2.5 pr-3 text-right text-machine-muted">
                    parallel
                  </td>
                  <td className="py-2.5 text-right text-machine-muted">
                    free tier
                  </td>
                </tr>
              )}
              <tr>
                <td className="py-2.5 pr-3">
                  <ActorChip
                    actor="code"
                    note="satellite, value, scores, checks"
                  />
                </td>
                <td className="py-2.5 pr-3 text-right text-machine-muted">—</td>
                <td className="py-2.5 pr-3 text-right text-machine-muted">—</td>
                <td className="py-2.5 pr-3 text-right text-machine-muted">—</td>
                <td className="py-2.5 text-right text-machine-muted">$0</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-machine-muted">
          Every model call goes through Nebius Token Factory and counts against
          the deployment&apos;s budget. Ultra is used only for the judgement;
          Super plans and Nano does the fast reading.
        </p>
      </section>
    </div>
  );
}
