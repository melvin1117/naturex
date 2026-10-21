/** The trade panel's quote table and receipt: the API's numbers, formatted, never computed. */
import type { Ref } from "react";

import type { OrderOut, QuoteOut } from "@/lib/api/types";
import { int } from "@/lib/prototype/format";
import {
  decimal,
  moneyText,
  unitPrice,
  unitPriceText,
  type Side,
} from "@/lib/trade";

export function QuoteTable({
  side,
  quote,
  loading,
  refreshing = false,
  fallbackPrice,
}: {
  side: Side;
  quote: QuoteOut | undefined;
  /** No quote for what's typed yet: show placeholders. */
  loading: boolean;
  /** The shown quote is being re-read (e.g. after a price tick). */
  refreshing?: boolean;
  fallbackPrice: number | null;
}) {
  const current = decimal(quote?.price) ?? fallbackPrice;
  const slippage = decimal(quote?.slippage_pct);
  return (
    <dl
      className="space-y-1.5 rounded-2xl bg-secondary p-4 text-sm transition-opacity aria-busy:opacity-60"
      aria-busy={loading || refreshing || undefined}
      aria-label="Quote"
    >
      <div className="flex justify-between gap-3">
        <dt className="text-muted-foreground">Price per unit</dt>
        <dd className="tabular">
          {current === null ? "—" : unitPrice(current)}
        </dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-muted-foreground">
          Fill price incl. slippage
          {slippage !== null && (
            <span className="tabular">
              {" "}
              ({slippage > 0 ? "+" : slippage < 0 ? "−" : ""}
              {Math.abs(slippage).toFixed(2)}%)
            </span>
          )}
        </dt>
        <dd className="tabular">
          {loading ? "…" : unitPriceText(quote?.fill_price)}
        </dd>
      </div>
      {quote && quote.primary_qty > 0 && (
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">To the community fund</dt>
          <dd className="tabular text-lime-ink">
            {moneyText(quote.community_amount)}
          </dd>
        </div>
      )}
      <div className="flex justify-between gap-3 border-t border-border pt-1.5 font-medium">
        <dt>{side === "buy" ? "Total" : "You receive"}</dt>
        <dd className="tabular">{loading ? "…" : moneyText(quote?.total)}</dd>
      </div>
    </dl>
  );
}

/** What screen readers hear once an order fills (the visible receipt isn't a live region). */
export function announce(order: OrderOut): string {
  const verb = order.side === "buy" ? "Bought" : "Sold";
  const paid = order.side === "buy" ? "You paid" : "You received";
  return `${verb} ${int(order.qty)} units at ${unitPriceText(order.fill_price)} each. ${paid} ${moneyText(
    order.total,
  )}. Play money now ${moneyText(order.cash_balance)}; ${int(order.shares_held)} units held.`;
}

/** The fill as the order returned it: totals, and the balance and holding right after it. */
export function Receipt({
  order,
  community,
  ref,
}: {
  order: OrderOut;
  community: string;
  /** The form moves focus here after an order, since its submit button is disabled. */
  ref?: Ref<HTMLDivElement>;
}) {
  const bought = order.side === "buy";
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="nx-rise mt-5 rounded-2xl border border-lime/60 bg-lime/10 p-4"
      data-tour="trade-receipt"
    >
      <p className="text-sm font-medium">
        {bought ? "Stake added" : "Stake reduced"}: {int(order.qty)} units at{" "}
        {unitPriceText(order.fill_price)}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <ReceiptCell
          label={bought ? "You paid" : "You received"}
          value={moneyText(order.total)}
        />
        <ReceiptCell
          label="Play money now"
          value={moneyText(order.cash_balance)}
        />
        <ReceiptCell label="Units held" value={int(order.shares_held)} />
      </dl>
      {order.primary_qty > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {int(order.primary_qty)} opening units:{" "}
          {moneyText(order.community_amount)} went straight to the community
          behind {community}. The land stays with the community.
        </p>
      )}
    </div>
  );
}

function ReceiptCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-1 font-semibold">{value}</dd>
    </div>
  );
}
