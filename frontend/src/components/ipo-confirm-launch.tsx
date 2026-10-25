"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { IpoPreview } from "@/lib/api/types";
import { SANDBOX_NOTE } from "@/lib/ipo";
import { int } from "@/lib/prototype/format";
import { unitPriceText } from "@/lib/trade";

/**
 * "Launch opening offer" and its confirmation (T64). The dialog shows and sends the preview
 * as it was when the owner opened it, so a refetch meanwhile can't change (or close) what
 * they're confirming; a newer price is the backend's 409 `ipo_price_changed` to explain.
 */
export function IpoConfirmLaunch({
  name,
  offer,
  disabled,
  pending,
  onConfirm,
}: {
  name: string;
  /** The preview to confirm; the button is disabled without one. */
  offer: IpoPreview | undefined;
  disabled: boolean;
  pending: boolean;
  onConfirm: (offer: IpoPreview) => void;
}) {
  const [confirming, setConfirming] = useState<IpoPreview | null>(null);
  return (
    <Dialog
      open={confirming !== null}
      onOpenChange={(open) => setConfirming(open ? (offer ?? null) : null)}
    >
      <DialogTrigger asChild>
        <Button className="mt-6 w-full" size="lg" disabled={disabled || !offer}>
          {pending ? (
            <>
              <Spinner aria-hidden="true" role="presentation" />
              Launching…
            </>
          ) : (
            "Launch opening offer"
          )}
        </Button>
      </DialogTrigger>
      {confirming && (
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setConfirming(null);
              onConfirm(confirming);
            }}
          >
            <DialogHeader>
              <DialogTitle>Open {name} to supporters?</DialogTitle>
              <DialogDescription>
                An opening offer launches once and can&apos;t be undone. Trading
                opens on the Marketplace straight away.
              </DialogDescription>
            </DialogHeader>
            <dl className="tabular grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Opening price per unit</dt>
              <dd className="text-right font-semibold">
                {unitPriceText(confirming.ipo_price)}
              </dd>
              <dt className="text-muted-foreground">Units offered</dt>
              <dd className="text-right">{int(confirming.shares_offered)}</dd>
              <dt className="text-muted-foreground">Your community keeps</dt>
              <dd className="text-right">
                {int(confirming.retained_shares)} units
              </dd>
            </dl>
            <p className="text-xs text-muted-foreground">{SANDBOX_NOTE}</p>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit">
                Launch at {unitPriceText(confirming.ipo_price)} per unit
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
