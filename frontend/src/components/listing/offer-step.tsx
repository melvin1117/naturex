"use client";

import {
  ArrowRight,
  BadgeCheck,
  Clock,
  PencilLine,
  Sprout,
} from "lucide-react";
import Link from "@/components/app-link";
import { useRouter } from "@/lib/nav";
import { useState } from "react";

import { IpoOfferInputs } from "@/components/ipo-offer-inputs";
import { IpoPriceSteps } from "@/components/ipo-preview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AssetDetail } from "@/lib/api/types";
import { int } from "@/lib/prototype/format";
import { useIpoPreview, useSwitchPersona } from "@/lib/hooks";
import { blockedExplanation, trimDecimal } from "@/lib/ipo";
import { useSendOffer } from "@/lib/offer-hooks";
import { assetHref, unitPriceText } from "@/lib/trade";
import { useIpoOffer } from "@/lib/use-ipo-offer";

import { StepCard } from "./shared";

/**
 * Offer (ADR-0008 §5): the community chooses how many units to issue and the share it keeps; the
 * rating sets the price. "Send for review" hands it to the Reviewer, whose approval opens the site
 * on the Marketplace. Sent, it waits (and can still change); sent back, it shows the note; once
 * approved, it says where the site is.
 */
export function OfferStep({ asset }: { asset: AssetDetail }) {
  const offer = asset.offer ?? null;
  const [editing, setEditing] = useState(false);
  if (asset.ipo_at) return <Launched asset={asset} />;
  if (offer?.sent_at && !editing)
    return <Waiting asset={asset} onChange={() => setEditing(true)} />;
  return <Compose asset={asset} onSent={() => setEditing(false)} />;
}

function Compose({
  asset,
  onSent,
}: {
  asset: AssetDetail;
  onSent: () => void;
}) {
  const offer = asset.offer ?? null;
  const send = useSendOffer(asset.id);
  const terms = useIpoOffer(asset.id, {
    launching: send.isPending,
    onEdit: () => send.reset(),
    initial: offer
      ? { totalShares: offer.total_shares, retainedPct: offer.retained_pct }
      : null,
  });
  const preview = terms.current ?? terms.shown;
  const blocked = terms.current?.blocked_reason;

  const submit = async () => {
    if (!terms.current || terms.totalShares === null || !terms.retainedPct)
      return;
    const sent = await send.mutate({
      total_shares: terms.totalShares,
      retained_pct: terms.retainedPct,
      expected_price: terms.current.ipo_price,
    });
    if (sent) onSent();
  };

  return (
    <StepCard>
      <h2 className="font-serif text-4xl leading-tight">Set your offer</h2>
      <p className="mt-2 max-w-prose text-muted-foreground">
        The rating sets the price. You choose how many units supporters can back
        and how much your community keeps. The land always stays yours.
      </p>
      {offer?.review_note && (
        <Alert className="mt-6">
          <PencilLine aria-hidden="true" />
          <AlertTitle>The Reviewer sent it back</AlertTitle>
          <AlertDescription>
            <p>&ldquo;{offer.review_note}&rdquo;</p>
            <p>Change what they asked for, then send it again.</p>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <IpoOfferInputs offer={terms} disabled={send.isPending} />
        {preview ? (
          <div
            className={terms.current ? "mt-6" : "mt-6 opacity-60"}
            aria-busy={!terms.current}
          >
            <p className="text-sm text-muted-foreground">Price a unit</p>
            <p className="tabular text-4xl font-light tracking-tight">
              {unitPriceText(preview.ipo_price)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {int(preview.shares_offered)} units on offer · your community
              keeps {int(preview.retained_shares)} (
              {trimDecimal(preview.retained_pct)}%)
            </p>
            <IpoPriceSteps preview={preview} className="mt-5" />
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground" role="status">
            Working out the price…
          </p>
        )}
      </div>
      {blocked && (
        <Alert className="mt-6">
          <AlertTitle>{blockedExplanation(blocked).title}</AlertTitle>
          <AlertDescription>
            <p>{blockedExplanation(blocked).body}</p>
          </AlertDescription>
        </Alert>
      )}
      {send.error && (
        <Alert variant="destructive" className="mt-6">
          <AlertTitle>We couldn&apos;t send your offer</AlertTitle>
          <AlertDescription>
            <p>{send.error.message}</p>
          </AlertDescription>
        </Alert>
      )}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          disabled={!terms.canLaunch}
          onClick={() => void submit()}
        >
          {send.isPending ? "Sending…" : "Send for review"}
          <ArrowRight aria-hidden="true" />
        </Button>
        <p className="text-sm text-muted-foreground">
          A WildWorth reviewer checks it. Once they approve, the site opens on
          the Marketplace.
        </p>
      </div>
    </StepCard>
  );
}

function Waiting({
  asset,
  onChange,
}: {
  asset: AssetDetail;
  onChange: () => void;
}) {
  const offer = asset.offer!;
  const router = useRouter();
  const switcher = useSwitchPersona();
  const preview = useIpoPreview(
    asset.id,
    offer.total_shares,
    offer.retained_pct,
  );
  return (
    <StepCard>
      <Clock className="size-8 text-lime-ink" aria-hidden="true" />
      <h2 className="mt-4 font-serif text-4xl leading-tight">
        Waiting for the Reviewer
      </h2>
      <p className="mt-2 max-w-prose text-muted-foreground">
        {asset.name} goes on the Marketplace once a WildWorth reviewer approves
        your offer. You can still change it until then.
      </p>
      <dl className="tabular mt-6 grid max-w-xl gap-4 rounded-2xl bg-secondary p-5 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Units issued</dt>
          <dd className="text-xl font-light">{int(offer.total_shares)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Community keeps</dt>
          <dd className="text-xl font-light">
            {trimDecimal(offer.retained_pct)}%
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Price a unit today</dt>
          <dd className="text-xl font-light">
            {preview.data ? unitPriceText(preview.data.ipo_price) : "—"}
          </dd>
        </div>
      </dl>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          disabled={switcher.isPending}
          onClick={async () => {
            if (await switcher.mutate("admin"))
              router.push("/admin/verifications");
          }}
        >
          <BadgeCheck aria-hidden="true" />
          Review it as the Reviewer
        </Button>
        <Button variant="outline" size="lg" onClick={onChange}>
          Change the offer
        </Button>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        In the sandbox you can be the Reviewer too, to see the other side.
      </p>
    </StepCard>
  );
}

function Launched({ asset }: { asset: AssetDetail }) {
  return (
    <StepCard>
      <Sprout className="size-8 text-lime-ink" aria-hidden="true" />
      <h2 className="mt-4 font-serif text-4xl leading-tight">
        {asset.name} is on the Marketplace
      </h2>
      <p className="mt-2 max-w-prose text-muted-foreground">
        The Reviewer approved your offer. Supporters can back it from now on,
        and what they pay goes to your community&apos;s fund.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href={assetHref(asset.id)}>
            See it on the Marketplace
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </StepCard>
  );
}
