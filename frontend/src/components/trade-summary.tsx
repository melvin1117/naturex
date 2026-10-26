/** The trade panel's quote table and receipt: the API's numbers, formatted, never computed. */
import Link from "@/components/app-link";
import { cn } from "cn";

import type { OrderOut, QuoteOut } from "@/lib/api/types";
import { int } from "@/lib/format";
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
      className="space-y-1.5 rounded-2xl bg-secondary p-4 text-sm [&_dd]:transition-colors aria-busy:[&_dd]:text-muted-foreground"
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
  const opened = opensStake(order) ? " You now hold a stake in this site." : "";
  return `${verb} ${int(order.qty)} units at ${unitPriceText(order.fill_price)} each. ${paid} ${moneyText(
    order.total,
  )}. Balance now ${moneyText(order.cash_balance)}; ${int(order.shares_held)} units held.${opened}`;
}

/**
 * The order opened a holding: every unit held came from this buy. A first stake, or a new one
 * after selling out (the order doesn't say which, so the wording fits both).
 */
export function opensStake(order: OrderOut): boolean {
  return order.side === "buy" && order.shares_held === order.qty;
}

/**
 * The fill as the order returned it: totals, and the balance and holding right after it. A
 * buy that opens a stake gets one more line (#216): where to follow it. Sober, as market
 * confirmations are.
 */
export function Receipt({
  order,
  community,
}: {
  order: OrderOut;
  community: string;
}) {
  const bought = order.side === "buy";
  const opened = opensStake(order);
  return (
    <div
      className={cn(
        "mt-5 rounded-2xl border border-lime/60 bg-lime/10 p-4",
        opened ? "ww-wash" : "ww-rise",
      )}
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
          label="Balance now"
          value={moneyText(order.cash_balance)}
        />
        <ReceiptCell label="Units held" value={int(order.shares_held)} />
      </dl>
      {/* The consequence also lives on another page: point to it here, not in a toast. */}
      {opened ? (
        <p className="mt-3 text-sm">
          You now hold a stake in {community}. Follow its rating and alerts in{" "}
          <Link
            href="/portfolio"
            className="font-medium underline underline-offset-4"
          >
            Your stakes
          </Link>
          .
        </p>
      ) : (
        <p className="mt-3 text-sm">
          <Link
            href="/portfolio"
            className="font-medium underline underline-offset-4"
          >
            View your stakes
          </Link>
        </p>
      )}
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
