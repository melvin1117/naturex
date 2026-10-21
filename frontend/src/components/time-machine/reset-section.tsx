"use client";

import { RotateCcw, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { Panel } from "@/components/proto/report-panels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { useWorld } from "@/lib/hooks";

/** "Reset the demo" (`POST /world/reset`): demo sandboxes only, after a confirmation. */
export function ResetSection({
  onReset,
  busy = false,
  className,
}: {
  onReset: () => void;
  /** A quarter or event is running: resetting under it would race the re-rates. */
  busy?: boolean;
  className?: string;
}) {
  const { resetWorld, isResetting, resetError } = useWorld();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const busyId = useId();

  return (
    <Panel title="Reset the demo" headingLevel="h2" className={className}>
      <p className="text-sm text-muted-foreground">
        Puts this sandbox back to the start: the first quarter, the original
        ratings, prices, holdings and alerts. The live world is never reset.
      </p>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            className="mt-4"
            disabled={isResetting || busy}
            aria-describedby={busy ? busyId : undefined}
          >
            {isResetting ? (
              <Spinner aria-hidden="true" role="presentation" />
            ) : (
              <RotateCcw aria-hidden="true" />
            )}
            {isResetting ? "Resetting…" : "Reset the demo"}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setConfirming(false);
              setDone(false);
              void resetWorld().then((world) => {
                setDone(Boolean(world));
                if (world) onReset();
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Reset this sandbox?</DialogTitle>
              <DialogDescription>
                Every quarter, event, trade and alert in this sandbox is undone.
                This can&apos;t be reversed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="destructive">
                Reset the demo
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {busy && (
        <p id={busyId} className="mt-3 text-sm text-muted-foreground">
          Available once the running quarter or event finishes.
        </p>
      )}
      <p role="status" aria-live="polite" className="mt-3 text-sm">
        {done && !isResetting && "The sandbox is back at the start."}
      </p>
      {resetError && (
        <Alert variant="destructive" className="mt-3">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>The demo wasn&apos;t reset</AlertTitle>
          <AlertDescription>
            <p>{resetError.message}</p>
          </AlertDescription>
        </Alert>
      )}
    </Panel>
  );
}
