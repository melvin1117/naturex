"use client";

import { ArrowRight, Check, Info, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "cn";

import { IpoCard, IpoShell } from "@/components/ipo-layout";
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
import { int } from "@/lib/prototype/format";
import { assetHref, unitPriceText } from "@/lib/trade";

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

/** The launch went through: the opening offer is live on the Exchange. */
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
  return (
    <IpoShell homeHref={homeHref}>
      <IpoCard className="text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-lime text-foreground">
          <Check className="size-7" aria-hidden="true" />
        </span>
        <Heading focus className="mt-4 text-4xl">
          {name} is open to supporters
        </Heading>
        <p className="mx-auto mt-2 max-w-lg text-muted-foreground">
          Opening price {unitPriceText(ipo.ipo_price)} per unit (play money).{" "}
          {int(ipo.shares_offered)} units are on offer; your community keeps{" "}
          {int(ipo.retained_shares)} units and all of the land.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
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
        <AlertTitle className="line-clamp-none">
          {content.explanation.title}
        </AlertTitle>
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
