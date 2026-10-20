"use client";

import { Ban, Check, ShieldX, X } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { VerificationRun } from "@/lib/api/types";
import { checkCounts } from "@/lib/verification";
import type { Decision } from "@/lib/verification-hooks";

export const REASON_MAX = 500;

/**
 * The reviewer's decision on a listing's current run (ADR-0006 §3). `review` approves (an
 * optional note) or rejects (a reason, required); `revoke` withdraws a verified run (a reason,
 * required, and a confirmation: trading is suspended at once). The backend re-checks it all;
 * its refusals are shown by the caller, which may reload the run.
 */
export function DecisionForm({
  run,
  listingName,
  kind,
  pending,
  onDecide,
}: {
  run: VerificationRun;
  listingName: string;
  kind: "review" | "revoke";
  pending: Decision | null;
  onDecide: (decision: Decision, reason: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const failed = checkCounts(run.checklist).fail;
  const stale = !run.fingerprint_matches;
  const busy = pending !== null;
  const trimmed = reason.trim();

  const decide = (decision: Decision) => {
    if (decision !== "approve" && !trimmed) {
      setMissing(true);
      return;
    }
    setMissing(false);
    if (decision === "revoke") {
      setConfirming(true);
      return;
    }
    onDecide(decision, trimmed);
  };

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${id}-reason`}>
          {kind === "revoke"
            ? "Reason for revoking (the steward sees it)"
            : "Reason or note for the steward"}
        </Label>
        <Textarea
          id={`${id}-reason`}
          name="reason"
          autoComplete="off"
          value={reason}
          maxLength={REASON_MAX}
          rows={4}
          onChange={(e) => {
            setReason(e.target.value);
            if (missing && e.target.value.trim()) setMissing(false);
          }}
          disabled={busy}
          aria-invalid={missing}
          aria-describedby={`${hintId}${missing ? ` ${errorId}` : ""}`}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {kind === "revoke"
            ? "Required."
            : "Required to reject; optional to approve."}{" "}
          {reason.length}/{REASON_MAX} characters. The public ledger keeps only
          a salted commitment to it, never the text.
        </p>
        {missing && (
          <p id={errorId} className="text-sm text-destructive">
            Write a reason: the steward needs to know what to fix.
          </p>
        )}
      </div>

      {kind === "review" ? (
        <>
          {(failed > 0 || stale) && (
            <p className="text-sm text-muted-foreground">
              {stale
                ? "The listing changed after this submission, so it can't be approved; reject it so the steward submits again."
                : `${failed} check${failed === 1 ? "" : "s"} failed, so this run can't be approved.`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => decide("approve")}
              disabled={busy || failed > 0 || stale}
            >
              {pending === "approve" ? (
                <Spinner aria-hidden="true" role="presentation" />
              ) : (
                <Check aria-hidden="true" />
              )}
              Approve
            </Button>
            <Button
              variant="outline"
              onClick={() => decide("reject")}
              disabled={busy}
            >
              {pending === "reject" ? (
                <Spinner aria-hidden="true" role="presentation" />
              ) : (
                <X aria-hidden="true" />
              )}
              Reject
            </Button>
          </div>
        </>
      ) : (
        <Button
          variant="destructive"
          onClick={() => decide("revoke")}
          disabled={busy}
        >
          {pending === "revoke" ? (
            <Spinner aria-hidden="true" role="presentation" />
          ) : (
            <ShieldX aria-hidden="true" />
          )}
          Revoke verification
        </Button>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke the verification of {listingName}?</DialogTitle>
            <DialogDescription>
              The public panel will say &ldquo;Verification revoked&rdquo; and
              trading is suspended at once. Only approving a new submission
              resumes it. Both changes go into the Nature Ledger.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep it verified</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                onDecide("revoke", trimmed);
              }}
            >
              <Ban aria-hidden="true" />
              Revoke and suspend trading
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
