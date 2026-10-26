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
 * when it's hovered or focused her wings and antennae stir for about two seconds, as if she's
 * ready to answer. Below `sm` only her avatar shows; the button's name stays "Ask Bea AI
 * assistant".
 */
export const AskBeaButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<typeof Button>, "asChild" | "children">
>(function AskBeaButton({ className, ...props }, ref) {
  // Its own provider (with the root's delay), so the button works wherever it's rendered.
  return (
    <TooltipProvider delayDuration={200}>
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
            <span className="max-sm:sr-only">Ask Bea</span>{" "}
            {/* Part of the name too ("Ask Bea AI assistant"): the disclosure isn't visual only. */}
            <span className="rounded-full bg-primary-foreground/15 px-1.5 py-0.5 font-mono text-[10px] leading-none tracking-[0.06em] max-sm:sr-only">
              AI
            </span>{" "}
            <span className="sr-only">assistant</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-center">
          Answers from the Record · NVIDIA {modelLabel(BEA_MODEL)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
