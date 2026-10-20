"use client";

import { useId } from "react";
import { cn } from "cn";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  DEFAULT_RETAINED_PCT,
  MAX_RETAINED_PCT,
  MIN_RETAINED_PCT,
  RETAINED_HINT,
  SHARES_HINT,
  sharesDisplay,
} from "@/lib/ipo";
import type { IpoOffer } from "@/lib/use-ipo-offer";

/** The owner's offering: units to issue and the % the community keeps (T64). */
export function IpoOfferInputs({
  offer,
  disabled = false,
}: {
  offer: IpoOffer;
  /** While the launch is in flight: nothing can change under it. */
  disabled?: boolean;
}) {
  const id = useId();
  const sharesHint = `${id}-shares-hint`;
  const retainedHint = `${id}-retained-hint`;
  const sharesValid = offer.totalShares !== null;
  const retainedValid = offer.retainedPct !== null;
  const sliderValue = Math.min(
    MAX_RETAINED_PCT,
    Math.max(
      MIN_RETAINED_PCT,
      Number(offer.retainedText) || DEFAULT_RETAINED_PCT,
    ),
  );
  return (
    <fieldset disabled={disabled} className="mt-6 min-w-0 space-y-6">
      <legend className="sr-only">Your offer</legend>
      <div className="space-y-2">
        <Label htmlFor={`${id}-shares`}>Units to issue</Label>
        <Input
          id={`${id}-shares`}
          name="total_shares"
          inputMode="numeric"
          autoComplete="off"
          value={sharesDisplay(offer.sharesText)}
          onChange={(e) => offer.setShares(e.target.value)}
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
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={`${id}-retained`}>Community keeps</Label>
          <div className="flex items-center gap-1">
            <Input
              id={`${id}-retained`}
              name="retained_pct"
              inputMode="decimal"
              autoComplete="off"
              value={offer.retainedText}
              onChange={(e) => offer.setRetained(e.target.value)}
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
          onValueChange={([v]) => offer.setRetained(String(v))}
          disabled={disabled}
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
    </fieldset>
  );
}
