"use client";

import { TimeMachineIcon } from "@/components/icons";
import { useState } from "react";

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
import { isJobActive } from "@/lib/time-machine";
import { useQuarterJob, useTimeMachine } from "@/lib/time-machine-hooks";

/**
 * The sandbox's Time Machine, one tap from any page and open to whoever the visitor is: move a
 * quarter on, or bring a fire, an encroachment or a restoration, and watch ratings, prices and
 * alerts follow on the page underneath once it closes.
 */
export function TimeMachineSheet() {
  const [open, setOpen] = useState(false);
  const job = useTimeMachine().data?.quarter_job;
  const running = isJobActive(job);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          className="relative h-10 gap-2 rounded-full px-3 text-[13.5px] max-sm:size-10 max-sm:px-0"
        >
          <TimeMachineIcon aria-hidden="true" className="size-[18px]" />
          <span className="max-sm:sr-only">Time Machine</span>
          {running && (
            <>
              <span
                aria-hidden="true"
                className="absolute top-1.5 right-1.5 size-2 rounded-full bg-lime ring-2 ring-background motion-safe:animate-pulse"
              />
              <span className="sr-only">, a quarter is running</span>
            </>
          )}
        </Button>
      </SheetTrigger>
      {/* The panel unmounts with the sheet: keep following a running quarter, so the page
          underneath still refreshes when it settles. */}
      {!open && running && job && <QuarterWatcher jobId={job.id} />}
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
        <div className="px-6 pb-10">
          <TimeMachinePanel variant="sheet" />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function QuarterWatcher({ jobId }: { jobId: string }) {
  useQuarterJob(jobId);
  return null;
}
