"use client";

import { History } from "lucide-react";

import { TimeMachinePanel } from "@/components/time-machine/time-machine-screen";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * The sandbox's Time Machine, one tap from any page and open to whoever the visitor is: move a
 * quarter on, or bring a fire, an encroachment or a restoration, and watch ratings, prices and
 * alerts follow on the page underneath once it closes.
 */
export function TimeMachineSheet() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          className="h-10 gap-2 rounded-full px-3 text-[13.5px] max-sm:size-10 max-sm:px-0"
        >
          <History aria-hidden="true" className="size-[18px]" />
          <span className="max-sm:sr-only">Time Machine</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto overscroll-contain bg-background p-0 sm:max-w-[40rem]"
      >
        <SheetHeader className="border-b border-border/70 bg-card px-6 pt-6 pb-5">
          <SheetTitle className="font-serif text-3xl font-normal tracking-tight">
            Time Machine
          </SheetTitle>
          <SheetDescription>
            Move your sandbox a quarter forward, or bring a fire, an
            encroachment or a restoration. Ratings, prices and alerts follow.
          </SheetDescription>
        </SheetHeader>
        <div className="px-6 pb-10 [&>div>div:first-child>section]:mt-6">
          <TimeMachinePanel variant="sheet" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
