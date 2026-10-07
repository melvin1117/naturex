"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useEvents,
  useLiveEvent,
  usePlaceOrder,
  usePortfolio,
  useWorld,
} from "@/lib/hooks";

/** Developer view of the data layer (T32): world, live transport, portfolio, last tick. */
export function DataLayerPanel() {
  const { world, personas, assets } = useWorld();
  const { transport } = useEvents();
  const portfolio = usePortfolio();
  const order = usePlaceOrder();
  const [lastTick, setLastTick] = useState<string | null>(null);
  useLiveEvent("price_tick", ({ id, payload }) =>
    setLastTick(`#${id} ${payload.price} (${payload.reason})`),
  );
  const listed = assets.find((asset) => asset.status === "listed");

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Data layer</CardTitle>
        <CardDescription>
          World {world?.label} · {personas.length} personas · {assets.length}{" "}
          assets
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>
          Live events <Badge variant="secondary">{transport}</Badge>
        </p>
        <p>
          Cash{" "}
          {portfolio.error
            ? portfolio.error.message
            : (portfolio.data?.cash_balance ?? "…")}
        </p>
        <p>Last price tick: {lastTick ?? "none yet"}</p>
        <Button
          size="sm"
          disabled={!listed || order.isPending}
          onClick={() => {
            if (listed) {
              void order.mutate({ asset_id: listed.id, side: "buy", qty: 1 });
            }
          }}
        >
          Buy 1 share of {listed?.name ?? "a listed asset"}
        </Button>
        {order.error && (
          <p role="alert" className="text-destructive">
            {order.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
