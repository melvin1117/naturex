"use client";

import { SheetDescription, SheetTitle } from "@/components/ui/sheet";

import { Bea, type BeaState } from "./bea";

/** The subtitle when Bea answers about one site (guidelines ch. 9). */
export const SITE_SUBTITLE = "Answers only from this site's Record";
/** …and across the sites in the visitor's world. */
export const WORLD_SUBTITLE = "Answers only from the Record of your sites";

/** Bea never gives advice, and her world is play money (AGENTS.md, sandbox framing). */
export const NOT_ADVICE = "Play money only; not advice.";

/**
 * Bea's panel title: her avatar, in the state of the conversation, then "Bea · your field
 * guide", what she answers from, and that none of it is advice.
 */
export function BeaSheetTitle({
  state,
  subtitle,
}: {
  state: BeaState;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Bea state={state} size={44} label="" />
      <div className="min-w-0 space-y-1">
        <SheetTitle className="font-serif text-2xl leading-none font-normal">
          Bea · your field guide
        </SheetTitle>
        <SheetDescription>
          {subtitle} <span className="block text-xs">{NOT_ADVICE}</span>
        </SheetDescription>
      </div>
    </div>
  );
}
