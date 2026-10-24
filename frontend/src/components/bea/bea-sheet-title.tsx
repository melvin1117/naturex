"use client";

import { SheetDescription, SheetTitle } from "@/components/ui/sheet";

import { Bea, type BeaState } from "./bea";

/** The subtitle when Bea answers about one site (guidelines ch. 9). */
export const SITE_SUBTITLE = "Answers only from this site's Record";
/** …and across the sites in the visitor's world. */
export const WORLD_SUBTITLE = "Answers only from the Record of your sites";

/**
 * Bea's panel title, as the character sheet's mock draws it: her avatar, in the state of the
 * conversation, then "Bea · your field guide" and what she answers from. That it's play money
 * and never advice is in the footnote under the question field (`BeaComposer`).
 */
export function BeaSheetTitle({
  state,
  subtitle,
}: {
  state: BeaState;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-3 pr-8">
      <Bea state={state} size={44} label="" />
      <div className="min-w-0">
        <SheetTitle className="font-serif text-[22px] leading-tight font-normal tracking-[-0.01em]">
          Bea · your field guide
        </SheetTitle>
        <SheetDescription className="mt-0.5 text-xs">
          {subtitle}
        </SheetDescription>
      </div>
    </div>
  );
}
