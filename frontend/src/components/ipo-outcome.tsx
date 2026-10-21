"use client";

import { ArrowRight, Check, Info, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "cn";

import { IpoCard, IpoShell } from "@/components/ipo-layout";
import { DotRing } from "@/components/proto/health-ring";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AssetDetail, IpoOut } from "@/lib/api/types";
import {
  NO_RATING,
  NOT_FOUND,
  notListedExplanation,
  OWNER_ONLY,
  SANDBOX_NOTE,
  type Explanation,
  type PageRefusal,
} from "@/lib/ipo";
import { DURATION } from "@/lib/motion";
import { int } from "@/lib/prototype/format";
import { assetHref, decimal, unitPriceText } from "@/lib/trade";

/** A page heading that takes focus when it appears, if `focus` (after the owner acted). */
function Heading({
  focus,
  className,
  children,
}: {
  focus: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <h1
      ref={ref}
      tabIndex={-1}
      className={cn("font-serif leading-tight outline-none", className)}
    >
      {children}
    </h1>
  );
}

/** Forwards props, so `<Button asChild>` can style it. */
function ExchangeLink({
  assetId,
  ...props
}: { assetId: string } & Omit<React.ComponentProps<typeof Link>, "href">) {
  return (
    <Link href={assetHref(assetId)} {...props}>
      See it on the Exchange
      <ArrowRight aria-hidden="true" />
    </Link>
  );
}

/** "51%" or "50.5%": a percentage as the API set it, without trailing zeros. */
function pct(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/**
 * The launch went through: the opening offer is live on the Exchange (#216's opening bell).
 * The dotted ring lights the stake's split: the community's kept share in forest, then the
 * share on offer in lime. Every number is the launch's own; under reduced motion it shows at once.
 */
export function IpoLaunched({
  assetId,
  name,
  ipo,
  homeHref,
}: {
  assetId: string;
  name: string;
  ipo: IpoOut;
  homeHref: string;
}) {
  const kept = decimal(ipo.retained_pct);
  const offered = kept === null ? null : 100 - kept;
  return (
    <IpoShell homeHref={homeHref}>
      <IpoCard className="text-center">
        {kept !== null && offered !== null ? (
          <DotRing
            size={176}
            className="mx-auto"
            segments={[
              { columns: Math.round(kept), className: "fill-primary" },
              { columns: 100 - Math.round(kept), className: "fill-lime" },
            ]}
            reveal={{ duration: DURATION.reveal }}
            label={`Your community keeps ${pct(kept)} of the stake; ${pct(offered)} is on offer to supporters.`}
          >
            <div className="nx-fade" style={{ animationDelay: "240ms" }}>
              <div className="tabular text-4xl leading-none font-light tracking-tight">
                {pct(kept)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                kept by your
                <br />
                community
              </div>
            </div>
          </DotRing>
        ) : (
          <span className="mx-auto grid size-14 place-items-center rounded-full bg-lime text-foreground">
            <Check className="size-7" aria-hidden="true" />
          </span>
        )}
        <Heading focus className="nx-rise mt-6 text-4xl text-balance">
          {name} is open to supporters
        </Heading>
        <p className="mx-auto mt-3 max-w-lg text-muted-foreground">
          Your opening offer is live on the Exchange. Supporters can take a
          stake from now on; your community keeps all of the land.
        </p>
        <dl className="mx-auto mt-6 grid max-w-2xl gap-2 rounded-2xl bg-secondary p-2 text-left sm:grid-cols-3">
          <OfferFact label="Opening price · play money">
            {unitPriceText(ipo.ipo_price)}
            <span className="text-sm text-muted-foreground"> per unit</span>
          </OfferFact>
          <OfferFact label="On offer" swatch="bg-lime">
            {int(ipo.shares_offered)}
            <span className="text-sm text-muted-foreground"> units</span>
          </OfferFact>
          <OfferFact label="Your community keeps" swatch="bg-primary">
            {int(ipo.retained_shares)}
            <span className="text-sm text-muted-foreground"> units</span>
          </OfferFact>
        </dl>
        <p className="mx-auto mt-6 max-w-lg text-sm text-muted-foreground">
          What&apos;s next: each unit a supporter takes from the offer pays into
          your community fund, and the land&apos;s rating keeps updating as it
          heals or comes under pressure.
        </p>
        <div
          className="nx-rise mt-6 flex flex-wrap justify-center gap-2"
          style={{ animationDelay: "480ms" }}
        >
          <Button asChild>
            <ExchangeLink assetId={assetId} />
          </Button>
          <Button asChild variant="outline">
            <Link href={homeHref}>Community home</Link>
          </Button>
        </div>
        <p className="mt-6 text-xs text-muted-foreground">{SANDBOX_NOTE}</p>
      </IpoCard>
    </IpoShell>
  );
}

/** One fact of the launched offer; `swatch` matches its share of the ring (the label says it too). */
function OfferFact({
  label,
  swatch,
  children,
}: {
  label: string;
  swatch?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-card px-4 py-3">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {swatch && (
          <span
            className={cn("size-2 shrink-0 rounded-full", swatch)}
            aria-hidden="true"
          />
        )}
        {label}
      </dt>
      <dd className="tabular mt-1 text-xl font-light tracking-tight">
        {children}
      </dd>
    </div>
  );
}

/**
 * Why this account can't launch here (a refusal that replaces the form). `focus` moves focus
 * to the heading, for when it replaces the form after the owner confirmed.
 */
export function IpoOutcome({
  kind,
  asset,
  assetId,
  homeHref,
  focus = false,
}: {
  kind: PageRefusal["kind"];
  asset: AssetDetail | undefined;
  assetId: string;
  homeHref: string;
  focus?: boolean;
}) {
  const name = asset?.name;
  const content: { explanation: Explanation; action?: ReactNode } = (() => {
    switch (kind) {
      case "launched":
        return {
          explanation: {
            title: "This opening offer has launched",
            body: `${name ?? "This site"} is already open to supporters. An opening offer launches only once; trading continues on the Exchange.`,
          },
          action: (
            <Button asChild size="sm" className="mt-3">
              <ExchangeLink assetId={assetId} />
            </Button>
          ),
        };
      case "not_listed":
        return { explanation: notListedExplanation(asset?.status) };
      case "no_rating":
        return { explanation: NO_RATING };
      case "owner_only":
        return { explanation: OWNER_ONLY };
      case "not_found":
        return { explanation: NOT_FOUND };
    }
  })();
  const Icon = kind === "owner_only" ? LockKeyhole : Info;
  return (
    <IpoShell homeHref={homeHref}>
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">Opening offer (IPO)</p>
        <Heading focus={focus} className="mt-1 text-4xl tracking-tight">
          {name ?? "Launch an opening offer"}
        </Heading>
      </header>
      <Alert className="max-w-2xl">
        <Icon aria-hidden="true" />
        <AlertTitle>{content.explanation.title}</AlertTitle>
        <AlertDescription>
          <p>{content.explanation.body}</p>
          {content.action}
        </AlertDescription>
      </Alert>
      <p className="mt-4 max-w-2xl text-xs text-muted-foreground">
        {SANDBOX_NOTE}
      </p>
    </IpoShell>
  );
}
