"use client";

import { ArrowRight, Info } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, OrderOut, QuoteOut } from "@/lib/api/types";
import { loginHref } from "@/lib/auth";
import { queryKeys, useDataLayer } from "@/lib/data-layer";
import { usePlaceOrder, usePortfolio, useQuote } from "@/lib/hooks";
import { int, price as fmtPrice } from "@/lib/prototype/format";
import {
  decimal,
  orderFailure,
  orderProblem,
  parseUnits,
  unitsInput,
  type OrderFailure,
  type Side,
} from "@/lib/trade";

const PRESETS = [10, 50, 100] as const;
const QUOTE_DELAY_MS = 250;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** The signed-in buy/sell form: validation, a backend quote, the order and its receipt. */
export function TradeForm({ asset }: { asset: AssetDetail }) {
  const ids = useId();
  const pathname = usePathname();
  const { cache } = useDataLayer();
  const portfolio = usePortfolio();
  const placeOrder = usePlaceOrder();
  const [chosenSide, setSide] = useState<Side>("buy");
  const [unitsText, setUnitsText] = useState("10");
  const [failure, setFailure] = useState<OrderFailure | null>(null);
  const [receipt, setReceipt] = useState<OrderOut | null>(null);
  const inFlight = useRef(false);

  const holding = portfolio.data?.holdings.find((h) => h.asset_id === asset.id);
  const held = holding?.shares ?? 0;
  const cash = decimal(portfolio.data?.cash_balance);
  // Selling everything disables the Sell tab, so fall back to Buy.
  const side: Side = held === 0 ? "buy" : chosenSide;
  const units = parseUnits(unitsText);
  const quotedUnits = useDebounced(units, QUOTE_DELAY_MS);
  const quote = useQuote(asset.id, side, quotedUnits ?? 0, {
    enabled: quotedUnits !== null,
  });
  const current =
    quote.data && quote.data.side === side && quote.data.qty === units
      ? quote.data
      : undefined;
  const problem = orderProblem({
    side,
    units,
    held,
    cash,
    quote: current,
    formatMoney: fmtPrice,
  });
  const quoteFailure =
    !current && quote.error && quotedUnits === units
      ? orderFailure(quote.error, { order: false })
      : null;
  const fieldMessage = problem ?? quoteFailure?.message ?? null;
  const ready = Boolean(current) && !problem && portfolio.data !== undefined;
  const pending = placeOrder.isPending;

  function change(next: string) {
    setUnitsText(unitsInput(next));
    setFailure(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !ready || units === null) return;
    inFlight.current = true;
    setFailure(null);
    try {
      setReceipt(
        await placeOrder.mutateAsync({ asset_id: asset.id, side, qty: units }),
      );
    } catch (error) {
      setFailure(orderFailure(error as ApiError));
      // Cash, holdings, supply or the price may have moved: show the backend's numbers now.
      cache.invalidate(queryKeys.portfolio());
      cache.invalidate(queryKeys.asset(asset.id));
      cache.invalidate(queryKeys.quotes(asset.id));
    } finally {
      inFlight.current = false;
    }
  }

  const unitsId = `${ids}-units`;
  const messageId = `${ids}-units-message`;
  const maxQty = current?.max_qty ?? quote.data?.max_qty ?? null;

  return (
    <Tabs value={side} onValueChange={(value) => setSide(value as Side)}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="buy">Buy units</TabsTrigger>
        <TabsTrigger value="sell" disabled={held === 0}>
          Sell units
        </TabsTrigger>
      </TabsList>
      <TabsContent value={side} className="mt-2">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={unitsId}>Units</Label>
              <span className="tabular text-xs text-muted-foreground">
                {portfolio.data
                  ? side === "buy"
                    ? `${cash === null ? "—" : fmtPrice(cash)} available`
                    : `${int(held)} held`
                  : portfolio.error
                    ? "Balance unavailable"
                    : "Loading your balance…"}
              </span>
            </div>
            <Input
              id={unitsId}
              name="units"
              inputMode="numeric"
              autoComplete="off"
              value={unitsText}
              onChange={(event) => change(event.target.value)}
              aria-invalid={fieldMessage ? true : undefined}
              aria-describedby={fieldMessage ? messageId : undefined}
              className="tabular text-lg"
            />
            {fieldMessage && (
              <p id={messageId} className="text-sm text-destructive">
                {fieldMessage}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((n) => (
                <Button
                  key={n}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="tabular px-3"
                  aria-label={`${n} units`}
                  onClick={() => change(String(n))}
                >
                  {n}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="px-3"
                disabled={!maxQty}
                onClick={() => maxQty && change(String(maxQty))}
              >
                Max
              </Button>
            </div>
          </div>
          <QuoteTable
            side={side}
            quote={current}
            loading={units !== null && !current && !quoteFailure}
            fallbackPrice={decimal(asset.price)}
          />
          <div role="alert">
            {failure && (
              <div className="rounded-2xl bg-destructive/10 p-3 text-sm text-destructive">
                <p>{failure.message}</p>
                {failure.signIn && (
                  <Link
                    href={loginHref(pathname)}
                    className="mt-1 inline-block font-medium underline"
                  >
                    Sign in again
                  </Link>
                )}
                {failure.uncertain && (
                  <Link
                    href="/portfolio"
                    className="mt-1 inline-block font-medium underline"
                  >
                    Check your stakes
                  </Link>
                )}
              </div>
            )}
          </div>
          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={!ready || pending}
            data-tour="trade-submit"
          >
            {pending
              ? side === "buy"
                ? "Buying…"
                : "Selling…"
              : `${side === "buy" ? "Buy" : "Sell"} ${units === null ? "" : `${int(units)} `}units`}
          </Button>
          <p className="flex gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Sandbox: play money, not a real security. Units are a share of the
            rating&apos;s sandbox market, not of the land. The order fills at
            the price when you confirm.
          </p>
        </form>
      </TabsContent>
      <p className="sr-only" role="status">
        {receipt ? announce(receipt) : ""}
      </p>
      {receipt && (
        <Receipt order={receipt} cash={cash} community={asset.name} />
      )}
    </Tabs>
  );
}

/** What screen readers hear once an order fills (the visible receipt isn't a live region). */
function announce(order: OrderOut): string {
  const total = decimal(order.total);
  const fill = decimal(order.fill_price);
  const verb = order.side === "buy" ? "Bought" : "Sold";
  return `${verb} ${int(order.qty)} units at ${fill === null ? "—" : fmtPrice(fill)} each. ${
    order.side === "buy" ? "You paid" : "You received"
  } ${total === null ? "—" : fmtPrice(total)}.`;
}

function QuoteTable({
  side,
  quote,
  loading,
  fallbackPrice,
}: {
  side: Side;
  quote: QuoteOut | undefined;
  loading: boolean;
  fallbackPrice: number | null;
}) {
  const show = (value: string | undefined) => {
    const n = decimal(value);
    return n === null ? "—" : fmtPrice(n);
  };
  const unitPrice = decimal(quote?.price) ?? fallbackPrice;
  const slippage = decimal(quote?.slippage_pct);
  return (
    <dl
      className="space-y-1.5 rounded-2xl bg-secondary p-4 text-sm"
      aria-busy={loading || undefined}
      aria-label="Quote"
    >
      <div className="flex justify-between gap-3">
        <dt className="text-muted-foreground">Price per unit</dt>
        <dd className="tabular">
          {unitPrice === null ? "—" : fmtPrice(unitPrice)}
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
        <dd className="tabular">{loading ? "…" : show(quote?.fill_price)}</dd>
      </div>
      {quote && quote.primary_qty > 0 && (
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">To the community fund</dt>
          <dd className="tabular text-lime-ink">
            {show(quote.community_amount)}
          </dd>
        </div>
      )}
      <div className="flex justify-between gap-3 border-t border-border pt-1.5 font-medium">
        <dt>{side === "buy" ? "Total" : "You receive"}</dt>
        <dd className="tabular">{loading ? "…" : show(quote?.total)}</dd>
      </div>
    </dl>
  );
}

function Receipt({
  order,
  cash,
  community,
}: {
  order: OrderOut;
  cash: number | null;
  community: string;
}) {
  const total = decimal(order.total);
  const toCommunity = decimal(order.community_amount);
  const fill = decimal(order.fill_price);
  const bought = order.side === "buy";
  return (
    <div
      className="nx-rise mt-5 rounded-2xl border border-lime/60 bg-lime/10 p-4"
      data-tour="trade-receipt"
    >
      <p className="text-sm font-medium">
        {bought ? "Stake added" : "Stake reduced"}: {int(order.qty)} units at{" "}
        {fill === null ? "—" : fmtPrice(fill)}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl bg-card p-3">
          <dt className="text-xs text-muted-foreground">
            {bought ? "You paid" : "You received"}
          </dt>
          <dd className="tabular mt-1 font-semibold">
            {total === null ? "—" : fmtPrice(total)}
          </dd>
        </div>
        <div className="rounded-xl bg-card p-3">
          <dt className="text-xs text-muted-foreground">Play money now</dt>
          <dd className="tabular mt-1 flex items-center gap-1 font-semibold">
            <ArrowRight
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            {cash === null ? "—" : fmtPrice(cash)}
          </dd>
        </div>
      </dl>
      {order.primary_qty > 0 && toCommunity !== null && (
        <p className="mt-2 text-xs text-muted-foreground">
          {int(order.primary_qty)} opening units: {fmtPrice(toCommunity)} went
          straight to the community behind {community}. The land stays with the
          community.
        </p>
      )}
    </div>
  );
}
