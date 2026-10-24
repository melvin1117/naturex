"use client";

import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "cn";

import { Bea } from "@/components/bea/bea";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BEA_MODEL } from "@/lib/bea";
import { modelLabel } from "@/lib/trace-view";

/**
 * The header's way to Bea, as the character sheet draws it (chapter 6): a forest pill with her
 * avatar and "Ask Bea". It says plainly that she's an AI ("AI", and the model in the tooltip);
 * her wings and antennae stir while it's hovered or focused, as if she's ready to answer.
 * Below `sm` only her avatar shows; the button's name stays "Ask Bea".
 */
export const AskBeaButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button>
>(function AskBeaButton({ className, ...props }, ref) {
  // Its own provider, so the button works wherever it's rendered (providers nest).
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            className={cn(
              "ask-bea h-10 gap-2 rounded-full py-1 pr-3 pl-1 text-[13.5px] max-sm:size-10 max-sm:p-1",
              className,
            )}
            {...props}
          >
            <Bea size={32} label="" />
            <span className="max-sm:sr-only">Ask Bea</span>
            <span
              aria-hidden="true"
              className="hidden rounded-full bg-primary-foreground/15 px-1.5 py-0.5 font-mono text-[10px] leading-none tracking-[0.06em] sm:inline"
            >
              AI
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64 text-center">
          Your AI field guide. She answers only from the Record, with sources.
          Runs on NVIDIA {modelLabel(BEA_MODEL)}.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
