"use client";

import { Lock, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { TradeForm } from "@/components/trade-form";
import { Button } from "@/components/ui/button";
import type { AssetDetail } from "@/lib/api/types";
import { useAsset, useWorld } from "@/lib/hooks";
import { int } from "@/lib/format";
import { decimal, unitPriceText } from "@/lib/trade";

/**
 * Buy and sell one asset's units with play money (T18, story C2). Self-contained: give it the
 * asset's id and it reads the asset (`useAsset`), the account (`useWorld`), and, signed in,
 * the portfolio and a backend quote.
 */
export function TradePanel({ assetId }: { assetId: string }) {
  const asset = useAsset(assetId);
  const { status, world, error: sessionError, retry } = useWorld();

  let body: ReactNode;
  if (!asset.data) {
    body = asset.error ? (
      <Notice>
        <p>{asset.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void asset.refetch()}
        >
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
      </Notice>
    ) : (
      <PanelSkeleton />
    );
  } else if (status === "error" && !world) {
    body = (
      <Notice>
        <p>{sessionError?.message ?? "We couldn't check your session."}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void retry()}
        >
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
      </Notice>
    );
  } else if (!world) {
    body = <PanelSkeleton />;
  } else {
    const lock = lockReason(asset.data, world.me);
    if (lock === "no-session") {
      // The sandbox gate opens a session before any page shows: only a moment's gap.
      body = <PanelSkeleton />;
    } else if (lock) {
      body = (
        <>
          <PriceSummary asset={asset.data} />
          <Notice icon>{lock}</Notice>
        </>
      );
    } else {
      body = <TradeForm asset={asset.data} />;
    }
  }

  return (
    <section
      className="rounded-3xl bg-card p-6 shadow-soft"
      aria-labelledby="trade-title"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="trade-title" className="text-base font-semibold">
          Back this site
        </h2>
        <span className="text-xs text-muted-foreground">Play money only</span>
      </div>
      <div className="mt-4">{body}</div>
    </section>
  );
}

/** Why this viewer can't trade this asset now ("no-session" before the sandbox opens), or null. */
function lockReason(
  asset: AssetDetail,
  me: { is_admin: boolean } | null | undefined,
): string | null {
  if (asset.status === "suspended")
    return "Trading is paused on this site while the platform reviews it.";
  if (
    asset.status !== "listed" ||
    asset.trading !== true ||
    decimal(asset.price) === null
  )
    return "This site isn't trading yet. It opens for stakes once its community launches the opening offer.";
  if (!me) return "no-session";
  if (me.is_admin)
    return "The Reviewer doesn't back sites. Switch to Arjun to back this one.";
  return null;
}

function PriceSummary({ asset }: { asset: AssetDetail }) {
  // No units exist before the opening offer (T59): `total_shares` is null until then.
  const issued = asset.total_shares ?? null;
  return (
    <dl className="grid grid-cols-2 gap-4 text-sm">
      <div>
        <dt className="text-xs text-muted-foreground">Price per unit</dt>
        <dd className="tabular text-xl font-light">
          {unitPriceText(asset.price)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Opening units left</dt>
        {issued === null ? (
          <>
            <dd className="tabular text-xl font-light">—</dd>
            <dd className="text-xs text-muted-foreground">
              Set at the opening offer
            </dd>
          </>
        ) : (
          <>
            <dd className="tabular text-xl font-light">
              {int(asset.primary_shares_remaining)}
            </dd>
            <dd className="text-xs text-muted-foreground">of {int(issued)}</dd>
          </>
        )}
      </div>
    </dl>
  );
}

function Notice({
  children,
  icon = false,
}: {
  children: ReactNode;
  icon?: boolean;
}) {
  return (
    <div className="mt-4 flex gap-3 rounded-2xl bg-secondary p-4 text-sm first:mt-0">
      {icon && (
        <Lock
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <div>{children}</div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the trade panel"
      className="space-y-3"
    >
      <div className="h-11 animate-pulse rounded-full bg-muted" />
      <div className="h-12 animate-pulse rounded-xl bg-muted" />
      <div className="h-28 animate-pulse rounded-2xl bg-muted" />
    </div>
  );
}
