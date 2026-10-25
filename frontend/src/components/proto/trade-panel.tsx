"use client";

import { ArrowRight, Info, Lock } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { price as fmtPrice } from "@/lib/prototype/format";
import {
  maxAffordableUnits,
  maxOrderUnits,
  quote,
  type Side,
} from "@/lib/prototype/market";
import { usePrototype } from "@/lib/prototype/store";
import {
  actingTrader,
  PERSONAS,
  type Site,
  type TraderKey,
} from "@/lib/prototype/world";

export function TradePanel({ site }: { site: Site }) {
  const { world, placeOrder } = usePrototype();
  const [chosenSide, setSide] = useState<Side>("buy");
  const [unitsText, setUnitsText] = useState("100");
  const [error, setError] = useState<string | null>(null);
  const persona = world.persona;
  const trader: TraderKey | null = actingTrader(persona);
  const units = Number(unitsText);
  const valid = Number.isInteger(units) && units > 0;
  const cash = trader ? world.cash[trader] : 0;
  const held = trader
    ? (world.holdings[trader].find((h) => h.siteId === site.id)?.units ?? 0)
    : 0;
  // Selling everything disables the Sell tab, so fall back to Buy.
  const side: Side = held === 0 ? "buy" : chosenSide;
  const fill = valid
    ? quote(site.price, side, units, site.totalUnits)
    : site.price;
  const total = valid ? fill * units : 0;
  const primary =
    side === "buy" && valid ? Math.min(units, site.primaryRemaining) : 0;
  const receipt =
    world.lastReceipt?.siteId === site.id ? world.lastReceipt : null;
  const insider = trader === "steward" && site.stewardOwned;
  const blocked = !trader || insider || site.status !== "listed";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trader) return;
    const result = placeOrder(trader, site.id, side, units);
    setError(result.ok ? null : result.message);
  }

  return (
    <section
      className="rounded-3xl bg-card p-6 shadow-soft"
      data-tour="trade-panel"
      aria-labelledby="trade-title"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="trade-title" className="text-base font-semibold">
          Back this site
        </h2>
        <span className="text-xs text-muted-foreground">Play money only</span>
      </div>

      {blocked ? (
        <div className="mt-4 flex gap-3 rounded-2xl bg-secondary p-4 text-sm">
          <Lock
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p>
            {site.status === "suspended"
              ? "Trading is paused on this site while the platform reviews it."
              : site.status !== "listed"
                ? "This site opens for stakes after its community launches the opening offer."
                : insider
                  ? "Members of a community can't trade their own site's stakes. Your community earns from its retained stake instead."
                  : "Admins can't trade. Switch to Arjun in the demo bar to back this site."}
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-4">
          <Tabs value={side} onValueChange={(v) => setSide(v as Side)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="buy">Buy units</TabsTrigger>
              <TabsTrigger value="sell" disabled={held === 0}>
                Sell units
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="units">Units</Label>
              <span className="text-xs text-muted-foreground">
                {side === "buy"
                  ? `${fmtPrice(cash)} available`
                  : `${held} held`}
              </span>
            </div>
            <Input
              id="units"
              inputMode="numeric"
              value={unitsText}
              onChange={(e) => {
                setUnitsText(e.target.value.replace(/[^\d]/g, ""));
                setError(null);
              }}
              aria-invalid={!valid || undefined}
              aria-describedby={error ? "trade-error" : undefined}
              className="tabular text-lg"
            />
            <div className="flex gap-1.5">
              {[10, 50, 100].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setUnitsText(String(n))}
                  className="tabular rounded-full border border-input px-3 py-1 text-xs font-medium hover:bg-accent"
                >
                  {n}
                </button>
              ))}
              <button
                type="button"
                onClick={() =>
                  setUnitsText(
                    String(
                      Math.max(
                        0,
                        side === "buy"
                          ? maxAffordableUnits(
                              site.price,
                              cash,
                              site.totalUnits,
                              site.primaryRemaining + site.marketMakerUnits,
                            )
                          : Math.min(held, maxOrderUnits(site.totalUnits)),
                      ),
                    ),
                  )
                }
                className="rounded-full border border-input px-3 py-1 text-xs font-medium hover:bg-accent"
              >
                Max
              </button>
            </div>
          </div>
          <dl className="space-y-1.5 rounded-2xl bg-secondary p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Price per unit</dt>
              <dd className="tabular">{fmtPrice(site.price)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">
                Fill price incl. slippage
              </dt>
              <dd className="tabular">{fmtPrice(fill)}</dd>
            </div>
            {primary > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">To the community fund</dt>
                <dd className="tabular text-lime-ink">
                  {fmtPrice(primary * fill)}
                </dd>
              </div>
            )}
            <div className="flex justify-between border-t border-border pt-1.5 font-medium">
              <dt>{side === "buy" ? "Total" : "You receive"}</dt>
              <dd className="tabular">{fmtPrice(total)}</dd>
            </div>
          </dl>
          {error && (
            <p
              id="trade-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={!valid}
            data-tour="trade-submit"
          >
            {side === "buy"
              ? `Buy ${valid ? units : ""} units`
              : `Sell ${valid ? units : ""} units`}
          </Button>
          <p className="flex gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Sandbox: play money, not a real security. Units are a share of the
            rating&apos;s sandbox market, not of the land.
          </p>
        </form>
      )}

      {receipt && (
        <div
          className="ww-rise mt-5 rounded-2xl border border-lime/60 bg-lime/10 p-4"
          data-tour="trade-receipt"
          role="status"
        >
          <div className="text-sm font-medium">
            {receipt.side === "buy" ? "Stake added" : "Stake reduced"}:{" "}
            {receipt.units} units at {fmtPrice(receipt.fill)}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <SplitCell
              who={`${PERSONAS[receipt.trader].name}'s play money`}
              before={receipt.cashBefore}
              after={receipt.cashAfter}
            />
            <SplitCell
              who="Community fund"
              before={receipt.fundBefore}
              after={receipt.fundAfter}
            />
          </div>
          {receipt.primaryUnits > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {receipt.primaryUnits} primary units: the money went straight to{" "}
              {site.community}. The land stays with the community.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SplitCell({
  who,
  before,
  after,
}: {
  who: string;
  before: number;
  after: number;
}) {
  const up = after > before;
  return (
    <div className="rounded-xl bg-card p-3">
      <div className="text-xs text-muted-foreground">{who}</div>
      <div className="tabular mt-1 flex flex-wrap items-center gap-1 text-sm">
        <span className="text-muted-foreground">{fmtPrice(before)}</span>
        <ArrowRight
          className="size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <span
          className={cn(
            "font-semibold",
            up ? "text-lime-ink" : after < before ? "text-clay-ink" : "",
          )}
        >
          {fmtPrice(after)}
        </span>
      </div>
    </div>
  );
}
