"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  Info,
  LockKeyhole,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";

import { IpoPriceSteps } from "@/components/ipo-preview";
import { useOptionalStewardCommunity } from "@/components/shell/steward-community";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, IpoOut, IpoPreview } from "@/lib/api/types";
import { isApiAssetId } from "@/lib/asset-detail";
import { useAsset, useIpoPreview, useLaunchIpo } from "@/lib/hooks";
import {
  blockedExplanation,
  DEFAULT_RETAINED_PCT,
  DEFAULT_TOTAL_SHARES,
  ipoRefusal,
  MAX_RETAINED_PCT,
  MIN_RETAINED_PCT,
  NO_RATING,
  NOT_FOUND,
  notListedExplanation,
  OWNER_ONLY,
  parseRetainedPct,
  parseTotalShares,
  PREVIEW_DEBOUNCE_MS,
  PRICE_CHANGED,
  previewMatches,
  RETAINED_HINT,
  retainedInput,
  SANDBOX_NOTE,
  SHARES_HINT,
  sharesInput,
  type Explanation,
  type IpoRefusal,
} from "@/lib/ipo";
import { assetHref, unitPriceText } from "@/lib/trade";

const int = (n: number) => n.toLocaleString("en-US");

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Page-level outcomes: anything that replaces the form. */
type PageState =
  "launched" | "not_listed" | "no_rating" | "owner_only" | "not_found";

const PAGE_STATES = new Set<IpoRefusal["kind"]>([
  "launched",
  "not_listed",
  "no_rating",
  "owner_only",
  "not_found",
]);

function pageState(error: ApiError | null): PageState | null {
  if (!error) return null;
  const refusal = ipoRefusal(error);
  return PAGE_STATES.has(refusal.kind) ? (refusal.kind as PageState) : null;
}

function StepCard({ className, ...rest }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "rounded-[1.75rem] bg-card p-6 shadow-soft sm:p-8",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * The opening offer (IPO) launch screen (T64, story A7): the owner picks the units to issue
 * and the % the community keeps, reads the backend's price formula step by step, and launches
 * at the previewed price. Every number comes from the API; the backend authorizes the launch.
 */
export function IpoLaunch({ assetId }: { assetId: string }) {
  const validId = isApiAssetId(assetId);
  const asset = useAsset(validId ? assetId : undefined);
  const launch = useLaunchIpo(assetId);
  const steward = useOptionalStewardCommunity();
  const homeHref = steward ? steward.href("/steward") : "/steward";

  const [sharesText, setSharesText] = useState(String(DEFAULT_TOTAL_SHARES));
  const [retainedText, setRetainedText] = useState(
    String(DEFAULT_RETAINED_PCT),
  );
  const totalShares = parseTotalShares(sharesText);
  const retainedPct = parseRetainedPct(retainedText);
  // Both inputs settle together, so editing one then the other asks for one preview.
  const offerKey = JSON.stringify([totalShares, retainedPct]);
  const [debouncedShares, debouncedRetained] = JSON.parse(
    useDebounced(offerKey, PREVIEW_DEBOUNCE_MS),
  ) as [number | null, string | null];

  // Always asked, even for a launched or unlisted site: the backend's answer (403 before 409)
  // decides what the page says, so a steward learns the launch is the owner's.
  const preview = useIpoPreview(
    validId ? assetId : undefined,
    debouncedShares,
    debouncedRetained,
    { enabled: !launch.data },
  );

  // The last preview stays on screen (dimmed) while the next one loads.
  const [shown, setShown] = useState<IpoPreview | undefined>(preview.data);
  if (preview.data && preview.data !== shown) setShown(preview.data);

  const name = asset.data?.name ?? "This site";

  if (launch.data) {
    return (
      <Launched
        assetId={assetId}
        name={name}
        ipo={launch.data}
        homeHref={homeHref}
      />
    );
  }

  const state: PageState | null = !validId
    ? "not_found"
    : (pageState(launch.error) ??
      pageState(preview.error) ??
      (asset.error?.status === 404 ? "not_found" : null));

  if (state) {
    return (
      <Outcome
        state={state}
        asset={asset.data}
        assetId={assetId}
        homeHref={homeHref}
      />
    );
  }

  if (asset.error) {
    return (
      <Shell homeHref={homeHref}>
        <ErrorAlert
          title="We couldn't load this site"
          message={asset.error.message}
          onRetry={() => void asset.refetch()}
        />
      </Shell>
    );
  }

  // Until the first preview answers, the page doesn't know whether this account may launch.
  const firstPreview =
    !shown && (preview.status === "idle" || preview.status === "loading");
  if (!asset.data || firstPreview) {
    return (
      <Shell homeHref={homeHref}>
        <Loading>Checking this site…</Loading>
      </Shell>
    );
  }

  const inputsSettled =
    totalShares !== null &&
    retainedPct !== null &&
    totalShares === debouncedShares &&
    retainedPct === debouncedRetained;
  const current =
    inputsSettled &&
    preview.status === "success" &&
    preview.data &&
    previewMatches(preview.data, totalShares, retainedPct)
      ? preview.data
      : undefined;
  const previewRefusal = preview.error ? ipoRefusal(preview.error) : null;
  const launchRefusal = launch.error ? ipoRefusal(launch.error) : null;
  const canLaunch =
    current !== undefined &&
    current.launchable &&
    !preview.isFetching &&
    !launch.isPending;

  const confirm = (offer: IpoPreview) =>
    launch
      .mutate({
        total_shares: offer.total_shares,
        retained_pct: offer.retained_pct,
        expected_price: offer.ipo_price,
      })
      .then((done) => {
        // A newer report or a block that appeared since the preview: show the new answer.
        if (!done) void preview.refetch();
      });

  return (
    <Shell homeHref={homeHref}>
      <header>
        <p className="text-sm text-muted-foreground">Opening offer (IPO)</p>
        <h1 className="mt-1 font-serif text-4xl leading-tight tracking-tight sm:text-5xl">
          {asset.data.name}
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Choose how many units to issue and how much of the stake your
          community keeps. The rest opens to supporters at the fair price from
          the latest rating; what they pay goes to your community fund.
        </p>
      </header>
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <StepCard aria-labelledby="offer-heading">
          <h2 id="offer-heading" className="text-lg font-semibold">
            Your offer
          </h2>
          <OfferInputs
            sharesText={sharesText}
            retainedText={retainedText}
            onShares={(text) => setSharesText(sharesInput(text))}
            onRetained={(text) => setRetainedText(retainedInput(text))}
            sharesValid={totalShares !== null}
            retainedValid={retainedPct !== null}
          />
        </StepCard>
        <StepCard aria-labelledby="price-heading">
          <h2 id="price-heading" className="text-lg font-semibold">
            Opening price
          </h2>
          <div
            className="mt-4"
            aria-busy={preview.isFetching || !inputsSettled}
            aria-live="polite"
          >
            {previewRefusal?.kind === "blocked" ? (
              <BlockedAlert explanation={previewRefusal.explanation} />
            ) : previewRefusal?.kind === "error" ? (
              <ErrorAlert
                title="We couldn't price this offer"
                message={previewRefusal.message}
                onRetry={() => void preview.refetch()}
              />
            ) : totalShares === null || retainedPct === null ? (
              <p className="text-sm text-muted-foreground">
                Enter a valid offer to see its price.
              </p>
            ) : shown ? (
              <>
                {!current && (
                  <p
                    role="status"
                    className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <Spinner aria-hidden="true" role="presentation" />
                    Updating the preview…
                  </p>
                )}
                <IpoPriceSteps
                  preview={shown}
                  className={cn(!current && "opacity-50 transition-opacity")}
                />
              </>
            ) : (
              <Loading>Pricing your offer…</Loading>
            )}
          </div>
          {current && !current.launchable && current.blocked_reason && (
            <BlockedAlert
              className="mt-4"
              explanation={blockedExplanation(current.blocked_reason)}
            />
          )}
          {launchRefusal?.kind === "price_changed" && (
            <BlockedAlert className="mt-4" explanation={PRICE_CHANGED} />
          )}
          {launchRefusal?.kind === "blocked" &&
            current?.blocked_reason !== launchRefusal.code && (
              <BlockedAlert
                className="mt-4"
                explanation={launchRefusal.explanation}
              />
            )}
          {launchRefusal?.kind === "error" && (
            <Alert variant="destructive" className="mt-4">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle>The opening offer didn&apos;t launch</AlertTitle>
              <AlertDescription>{launchRefusal.message}</AlertDescription>
            </Alert>
          )}
          <ConfirmLaunch
            name={asset.data.name}
            offer={current}
            disabled={!canLaunch}
            pending={launch.isPending}
            onConfirm={confirm}
          />
          <p className="mt-3 text-xs text-muted-foreground">{SANDBOX_NOTE}</p>
        </StepCard>
      </div>
    </Shell>
  );
}

function OfferInputs({
  sharesText,
  retainedText,
  onShares,
  onRetained,
  sharesValid,
  retainedValid,
}: {
  sharesText: string;
  retainedText: string;
  onShares: (text: string) => void;
  onRetained: (text: string) => void;
  sharesValid: boolean;
  retainedValid: boolean;
}) {
  const id = useId();
  const sharesHint = `${id}-shares-hint`;
  const retainedHint = `${id}-retained-hint`;
  const sliderValue = Math.min(
    MAX_RETAINED_PCT,
    Math.max(MIN_RETAINED_PCT, Number(retainedText) || DEFAULT_RETAINED_PCT),
  );
  return (
    <div className="mt-6 space-y-6">
      <div className="space-y-2">
        <Label htmlFor={`${id}-shares`}>Units to issue</Label>
        <Input
          id={`${id}-shares`}
          inputMode="numeric"
          autoComplete="off"
          value={sharesText}
          onChange={(e) => onShares(e.target.value)}
          aria-invalid={!sharesValid}
          aria-describedby={sharesHint}
          className="tabular"
        />
        <p
          id={sharesHint}
          className={cn(
            "text-xs",
            sharesValid ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {SHARES_HINT}
        </p>
      </div>
      <div className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <Label htmlFor={`${id}-retained`}>Community keeps</Label>
          <div className="flex items-center gap-1">
            <Input
              id={`${id}-retained`}
              inputMode="decimal"
              autoComplete="off"
              value={retainedText}
              onChange={(e) => onRetained(e.target.value)}
              aria-invalid={!retainedValid}
              aria-describedby={retainedHint}
              className="tabular w-24 text-right text-lg"
            />
            <span aria-hidden="true" className="text-lg">
              %
            </span>
          </div>
        </div>
        <Slider
          min={MIN_RETAINED_PCT}
          max={MAX_RETAINED_PCT}
          step={1}
          value={[sliderValue]}
          onValueChange={([v]) => onRetained(String(v))}
          aria-label="Share of the stake the community keeps"
        />
        <p
          id={retainedHint}
          className={cn(
            "text-xs",
            retainedValid ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {RETAINED_HINT}
        </p>
      </div>
    </div>
  );
}

function ConfirmLaunch({
  name,
  offer,
  disabled,
  pending,
  onConfirm,
}: {
  name: string;
  offer: IpoPreview | undefined;
  disabled: boolean;
  pending: boolean;
  onConfirm: (offer: IpoPreview) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        className="mt-6 w-full"
        size="lg"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {pending ? (
          <>
            <Spinner aria-hidden="true" role="presentation" />
            Launching…
          </>
        ) : (
          "Launch opening offer"
        )}
      </Button>
      {offer && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open {name} to supporters?</DialogTitle>
            <DialogDescription>
              An opening offer launches once and can&apos;t be undone. Trading
              opens on the Exchange straight away.
            </DialogDescription>
          </DialogHeader>
          <dl className="tabular grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Opening price per unit</dt>
            <dd className="text-right font-semibold">
              {unitPriceText(offer.ipo_price)}
            </dd>
            <dt className="text-muted-foreground">Units offered</dt>
            <dd className="text-right">{int(offer.shares_offered)}</dd>
            <dt className="text-muted-foreground">Your community keeps</dt>
            <dd className="text-right">{int(offer.retained_shares)} units</dd>
          </dl>
          <p className="text-xs text-muted-foreground">{SANDBOX_NOTE}</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={() => {
                setOpen(false);
                void onConfirm(offer);
              }}
            >
              Launch at {unitPriceText(offer.ipo_price)} per unit
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

function Shell({
  homeHref,
  children,
}: {
  homeHref: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 pb-16 sm:px-6">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-3">
        <Link href={homeHref}>
          <ArrowLeft aria-hidden="true" />
          Community home
        </Link>
      </Button>
      {children}
    </div>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
    >
      <Spinner aria-hidden="true" role="presentation" />
      {children}
    </div>
  );
}

function BlockedAlert({
  explanation,
  className,
}: {
  explanation: Explanation;
  className?: string;
}) {
  return (
    <Alert className={className}>
      <Info aria-hidden="true" />
      <AlertTitle>{explanation.title}</AlertTitle>
      <AlertDescription>{explanation.body}</AlertDescription>
    </Alert>
  );
}

function ErrorAlert({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function FocusHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h1
      ref={ref}
      tabIndex={-1}
      className="mt-4 font-serif text-4xl leading-tight outline-none"
    >
      {children}
    </h1>
  );
}

function Launched({
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
    <Shell homeHref={homeHref}>
      <StepCard className="text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-lime text-foreground">
          <Check className="size-7" aria-hidden="true" />
        </span>
        <FocusHeading>{name} is open to supporters</FocusHeading>
        <p className="mx-auto mt-2 max-w-lg text-muted-foreground">
          Opening price {unitPriceText(ipo.ipo_price)} per unit (play money).{" "}
          {int(ipo.shares_offered)} units are on offer; your community keeps{" "}
          {int(ipo.retained_shares)} units and all of the land.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href={assetHref(assetId)}>
              See it on the Exchange
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={homeHref}>Community home</Link>
          </Button>
        </div>
        <p className="mt-6 text-xs text-muted-foreground">{SANDBOX_NOTE}</p>
      </StepCard>
    </Shell>
  );
}

function Outcome({
  state,
  asset,
  assetId,
  homeHref,
}: {
  state: PageState;
  asset: AssetDetail | undefined;
  assetId: string;
  homeHref: string;
}) {
  const name = asset?.name;
  const exchange = (
    <Button asChild size="sm" className="mt-3">
      <Link href={assetHref(assetId)}>
        See it on the Exchange
        <ArrowRight aria-hidden="true" />
      </Link>
    </Button>
  );
  const content: { explanation: Explanation; action?: ReactNode } = (() => {
    switch (state) {
      case "launched":
        return {
          explanation: {
            title: "This opening offer has launched",
            body: `${name ?? "This site"} is already open to supporters. An opening offer launches only once; trading continues on the Exchange.`,
          },
          action: exchange,
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
  const Icon = state === "owner_only" ? LockKeyhole : Info;
  return (
    <Shell homeHref={homeHref}>
      <header className="mb-6">
        <p className="text-sm text-muted-foreground">Opening offer (IPO)</p>
        <h1 className="mt-1 font-serif text-4xl leading-tight tracking-tight">
          {name ?? "Launch an opening offer"}
        </h1>
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
    </Shell>
  );
}
