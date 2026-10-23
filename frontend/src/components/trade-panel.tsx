"use client";

import { Lock, LogIn, RefreshCwIcon } from "lucide-react";
import Link from "@/components/app-link";
import { useSearchParams } from "next/navigation";
import { usePathname } from "@/lib/nav";
import type { ReactNode } from "react";

import { TradeForm } from "@/components/trade-form";
import { Button } from "@/components/ui/button";
import type { AssetDetail } from "@/lib/api/types";
import { loginHref } from "@/lib/auth";
import { useAsset, useWorld } from "@/lib/hooks";
import { int } from "@/lib/prototype/format";
import { decimal, unitPriceText } from "@/lib/trade";

/**
 * Buy and sell one asset's units with play money (T18, story C2). Self-contained: give it the
 * asset's id and it reads the asset (`useAsset`), the account (`useWorld`), and, signed in,
 * the portfolio and a backend quote. Anonymous visitors get "Sign in to trade", which comes
 * back to this page with its query string (`useSearchParams`, so render it inside `<Suspense>`
 * on a statically rendered route).
 */
export function TradePanel({ assetId }: { assetId: string }) {
  const asset = useAsset(assetId);
  const { status, world, error: sessionError, retry } = useWorld();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const signInHref = loginHref(search ? `${pathname}?${search}` : pathname);

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
    if (lock === "sign-in") {
      body = (
        <>
          <PriceSummary asset={asset.data} />
          <Button asChild className="mt-4 w-full" size="lg">
            <Link href={signInHref}>
              <LogIn aria-hidden="true" />
              Sign in to trade
            </Link>
          </Button>
          <p className="mt-3 text-xs text-muted-foreground">
            Every new account starts with $10,000 of play money.
          </p>
        </>
      );
    } else if (lock) {
      body = (
        <>
          <PriceSummary asset={asset.data} />
          <Notice icon>{lock}</Notice>
        </>
      );
    } else {
      body = <TradeForm asset={asset.data} signInHref={signInHref} />;
    }
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
      <div className="mt-4">{body}</div>
    </section>
  );
}

/** Why this viewer can't trade this asset now ("sign-in" for anonymous), or null. */
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
  if (!me) return "sign-in";
  if (me.is_admin)
    return "Admin accounts can't trade. Use a separate investor account to back sites.";
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
