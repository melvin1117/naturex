"use client";

import { Lockup } from "@/components/brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import { DATA_ATTRIBUTIONS } from "@/lib/prototype/data";

/** One quiet line under every sandbox page; the data credits sit behind "Data sources". */
export function SandboxFooter() {
  return (
    <footer className="mt-20 border-t border-border/70">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-6 pr-20 text-xs text-muted-foreground sm:px-6 sm:pr-24">
        <Lockup size={16} />
        <span>
          A hackathon prototype. Values are screening estimates, not appraisals.
        </span>
        <Dialog>
          <DialogTrigger className="rounded-sm underline underline-offset-4 hover:text-foreground">
            Data sources
          </DialogTrigger>
          <DialogContent className="rounded-3xl">
            <DialogHeader>
              <DialogTitle>Data sources</DialogTitle>
              <DialogDescription>
                Ratings are computed from open satellite datasets and published
                valuation coefficients.
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-1.5 text-sm">
              {[...DATA_ATTRIBUTIONS, IMAGERY_ATTRIBUTION].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>
      </div>
    </footer>
  );
}
