"use client";

import { Archive, TriangleAlert } from "lucide-react";
import { useRef, useState, type MouseEvent } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail } from "@/lib/api/types";
import { useLeaveReview } from "@/lib/hooks";
import { withdrawFailure, type WithdrawFailure } from "@/lib/steward-listings";

/**
 * Withdraw a listing that never opened (#233): a confirmation that says what happens, the
 * refusal inline in the dialog (feedback rung 1), and on success the caller moves the row to
 * Closed in place (rung 2) and takes focus there, since the button that had it is gone.
 */
export function WithdrawListingDialog({
  assetId,
  name,
  onWithdrawn,
  onStale,
}: {
  assetId: string;
  name: string;
  /** After the API accepted it: refresh the list. The dialog closes once this settles. */
  onWithdrawn: (asset: AssetDetail) => Promise<void> | void;
  /** The API refused because the list is out of date: refresh it once the dialog closes. */
  onStale: () => void;
}) {
  const withdraw = useLeaveReview("withdraw");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WithdrawFailure | null>(null);
  // Focus moves to the withdrawn row, not back to a trigger that no longer exists.
  const done = useRef(false);
  // Refreshing behind an open dialog could remove its row (and the dialog) mid-read.
  const stale = useRef(false);

  async function confirm(event: MouseEvent) {
    event.preventDefault(); // stay open until it's done, to show progress or the refusal
    setFailure(null);
    setBusy(true);
    try {
      const asset = await withdraw.mutateAsync(assetId);
      await onWithdrawn(asset);
      done.current = true;
      setOpen(false);
    } catch (error) {
      const failed = withdrawFailure(error as ApiError);
      setFailure(failed);
      stale.current ||= failed.stale;
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) setFailure(null);
        setOpen(next);
        if (!next && stale.current) {
          stale.current = false;
          onStale();
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          aria-label={`Withdraw ${name}`}
        >
          <Archive aria-hidden="true" />
          Withdraw
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (done.current) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Withdraw {name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                It stops here and moves to Closed. Withdrawing is final: it
                can&apos;t be submitted again, but you can list the same land as
                a new listing.
              </p>
              <p>
                Nothing is deleted. Its details, boundary and record stay with
                your community. It never opened to supporters, so no one holds
                units and no payouts change.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failure && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{failure.title}</AlertTitle>
            <AlertDescription>
              <p>{failure.message}</p>
            </AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => void confirm(event)}
            disabled={busy}
          >
            {busy ? "Withdrawing…" : "Withdraw listing"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
