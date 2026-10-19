"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { TradePanel } from "@/components/trade-panel";
import { useAssets } from "@/lib/hooks";
import { price } from "@/lib/prototype/format";
import { decimal } from "@/lib/trade";

/** `/dev/trade?asset=<id>`: pick a real asset, trade it with the real panel. */
export function DevTrade() {
  const assets = useAssets();
  const chosen = useSearchParams().get("asset");
  const assetId = chosen ?? assets.data?.[0]?.id;
  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section aria-labelledby="dev-trade-title">
        <h1 id="dev-trade-title" className="font-serif text-4xl tracking-tight">
          Trade panel
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The real trade panel on this session&apos;s world, until the asset
          page shows it.
        </p>
        {assets.error && (
          <p className="mt-4 text-sm text-destructive">
            {assets.error.message}
          </p>
        )}
        <ul className="mt-6 divide-y rounded-2xl bg-card text-sm shadow-soft">
          {(assets.data ?? []).map((asset) => {
            const current = decimal(asset.price);
            return (
              <li key={asset.id}>
                <Link
                  href={`/dev/trade?asset=${asset.id}`}
                  aria-current={asset.id === assetId ? "page" : undefined}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent aria-[current=page]:font-semibold"
                >
                  <span>{asset.name}</span>
                  <span className="tabular text-muted-foreground">
                    {asset.status} · {current === null ? "—" : price(current)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
      <div className="lg:sticky lg:top-24 lg:self-start">
        {assetId && <TradePanel key={assetId} assetId={assetId} />}
      </div>
    </div>
  );
}
