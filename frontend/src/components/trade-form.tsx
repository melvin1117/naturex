"use client";

import { Info } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";

import { announce, QuoteTable, Receipt } from "@/components/trade-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, OrderCreate, OrderOut } from "@/lib/api/types";
import { queryKeys, useDataLayer } from "@/lib/data-layer";
import { usePlaceOrder, usePortfolio, useQuote } from "@/lib/hooks";
import { int } from "@/lib/prototype/format";
import {
  decimal,
  money,
  orderFailure,
  orderProblem,
  parseUnits,
  tradeBlockedMessage,
  unitsInput,
  type OrderFailure,
  type Side,
} from "@/lib/trade";
import { useDebounced } from "@/lib/use-debounced";

const PRESETS = [10, 50, 100] as const;
const QUOTE_DELAY_MS = 250;

/** The signed-in buy/sell form: validation, a backend quote, the order and its receipt. */
export function TradeForm({
  asset,
  signInHref,
}: {
  asset: AssetDetail;
  /** Sign-in that comes back to this page, query string included. */
  signInHref: string;
}) {
  const ids = useId();
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
  // Only a settled quote for exactly what's on screen can be confirmed: never one that's
  // being refreshed after a price tick, since the user hasn't seen the new total yet.
  const settled =
    current !== undefined && !quote.isFetching && quote.status === "success";
  const problem = orderProblem({
    side,
    units,
    held,
    cash,
    quote: current,
    formatMoney: money,
  });
  const quoteFailure =
    !current && quote.error && quotedUnits === units
      ? orderFailure(quote.error, { order: false })
      : null;
  // The backend's own TRADE decision (insider, admin, treasury): explain it, never offer it.
  const blocked = (current ?? quote.data)?.trade_blocked_reason ?? null;
  const fieldMessage = blocked
    ? tradeBlockedMessage(blocked)
    : (problem ?? quoteFailure?.message ?? null);
  const ready = settled && !blocked && !problem && portfolio.data !== undefined;
  const pending = placeOrder.isPending;

  function change(next: string) {
    setUnitsText(unitsInput(next));
    setFailure(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !ready || units === null || !current) return;
    inFlight.current = true;
    setFailure(null);
    // The total the user saw: the backend refuses a worse fill (409 price_moved).
    const order: OrderCreate =
      side === "buy"
        ? { asset_id: asset.id, side, qty: units, max_total: current.total }
        : { asset_id: asset.id, side, qty: units, min_total: current.total };
    try {
      setReceipt(await placeOrder.mutateAsync(order));
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
  // Radix points every trigger at its panel, but only the active side's panel is rendered.
  const noPanel = { "aria-controls": undefined };

  return (
    <Tabs value={side} onValueChange={(value) => setSide(value as Side)}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="buy" {...(side === "buy" ? {} : noPanel)}>
          Buy units
        </TabsTrigger>
        <TabsTrigger
          value="sell"
          disabled={held === 0}
          {...(side === "sell" ? {} : noPanel)}
        >
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
                    ? `${cash === null ? "—" : money(cash)} available`
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
              aria-invalid={fieldMessage && !blocked ? true : undefined}
              aria-describedby={fieldMessage ? messageId : undefined}
              className="tabular text-lg"
            />
            {/* Always rendered so a quote error arriving later is announced. */}
            <p
              id={messageId}
              aria-live="polite"
              className="text-sm text-destructive"
            >
              {fieldMessage}
            </p>
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
            refreshing={current !== undefined && quote.isFetching}
            fallbackPrice={decimal(asset.price)}
          />
          <div role="alert">
            {failure && (
              <div className="rounded-2xl bg-destructive/10 p-3 text-sm text-destructive">
                <p>{failure.message}</p>
                {failure.signIn && (
                  <Link
                    href={signInHref}
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
            the price when you confirm, never worse than the total shown.
          </p>
        </form>
      </TabsContent>
      <p className="sr-only" role="status">
        {receipt ? announce(receipt) : ""}
      </p>
      {receipt && <Receipt order={receipt} community={asset.name} />}
    </Tabs>
  );
}
