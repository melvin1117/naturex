"use client";

import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  FileCheck2,
  FileWarning,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import { AiUploadNotice } from "@/components/verification/ai-upload-notice";
import { DocumentUploadForm } from "@/components/verification/document-upload-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AssetDetail, VerificationRun } from "@/lib/api/types";
import {
  currentRun,
  DOC_TYPE_LABEL,
  MAX_RUN_DOCUMENTS,
  submitFailure,
  waitingRun,
} from "@/lib/verification";
import {
  useSubmitVerification,
  useVerificationRuns,
} from "@/lib/verification-hooks";

import { StepCard } from "./shared";

/**
 * Prove (ADR-0008 §5): documents that show the community may list this land, each sent to the
 * Reviewer as soon as it's uploaded (added to the submission waiting for them). Optional in the
 * sandbox: the Reviewer can approve the offer without them.
 */
export function ProveStep({
  asset,
  onBack,
  onContinue,
}: {
  asset: AssetDetail;
  onBack: () => void;
  onContinue: () => void;
}) {
  const runs = useVerificationRuns(asset.id);
  const submit = useSubmitVerification(asset.id);
  const waiting = runs.data ? waitingRun(runs.data) : null;
  const current = currentRun(runs.data);
  const decided = current && current !== waiting ? current : null;
  const sent = waiting?.documents ?? [];
  const full = sent.length >= MAX_RUN_DOCUMENTS;
  const [sending, setSending] = useState<string | null>(null);

  return (
    <StepCard>
      <h2 className="font-serif text-4xl leading-tight">
        Show it&apos;s yours
      </h2>
      <p className="mt-2 max-w-prose text-muted-foreground">
        A land title, the assembly&apos;s minutes approving the listing, or your
        cooperative&apos;s registration. The Reviewer reads them with your
        offer.
      </p>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        For the hackathon this step is optional: you can skip it, and the
        Reviewer can still approve.
      </p>

      {decided && <Decision run={decided} />}

      {sent.length > 0 && (
        <ul className="mt-6 space-y-2" aria-label="Sent to the Reviewer">
          {sent.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center gap-3 rounded-2xl bg-secondary px-4 py-3 text-sm"
            >
              <FileCheck2
                className="size-4 shrink-0 text-lime-ink"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {DOC_TYPE_LABEL[doc.doc_type]}
              </span>
              <span className="text-xs text-muted-foreground">
                Sent to the Reviewer
              </span>
            </li>
          ))}
        </ul>
      )}

      {!full && (
        <div className="mt-6 max-w-xl space-y-4">
          {/* ADR-0006 §5: who may read the documents, before they're uploaded. */}
          <AiUploadNotice />
          <DocumentUploadForm
            assetId={asset.id}
            disabled={sending !== null}
            onUploaded={(doc) => {
              setSending(doc.id);
              void submit
                .mutate({ documentIds: [doc.id] })
                .finally(() => setSending(null));
            }}
          />
        </div>
      )}
      {submit.error && (
        <Alert variant="destructive" className="mt-4">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>We couldn&apos;t send that document</AlertTitle>
          <AlertDescription>
            <p>{submitFailure(submit.error)}</p>
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="lg"
          onClick={onBack}
          disabled={sending !== null}
        >
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
        <Button
          size="lg"
          variant={sent.length > 0 ? "default" : "outline"}
          onClick={onContinue}
          disabled={sending !== null}
        >
          {sent.length > 0 ? "Continue to your offer" : "Skip for now"}
          <ArrowRight aria-hidden="true" />
        </Button>
        {full && (
          <p className="text-sm text-muted-foreground">
            That&apos;s the most a submission takes ({MAX_RUN_DOCUMENTS}).
          </p>
        )}
      </div>
    </StepCard>
  );
}

/** The Reviewer's latest decision on the documents, and what to do about it. */
function Decision({ run }: { run: VerificationRun }) {
  if (!run.fingerprint_matches && run.level !== "revoked")
    return (
      <Alert className="mt-6">
        <FileWarning aria-hidden="true" />
        <AlertTitle>The listing changed since its review</AlertTitle>
        <AlertDescription>
          <p>Send the documents again for a new review.</p>
        </AlertDescription>
      </Alert>
    );
  switch (run.level) {
    case "verified":
      return (
        <Alert className="mt-6">
          <BadgeCheck aria-hidden="true" />
          <AlertTitle>The Reviewer verified your documents</AlertTitle>
          {run.reason && (
            <AlertDescription>
              <p>&ldquo;{run.reason}&rdquo;</p>
            </AlertDescription>
          )}
        </Alert>
      );
    case "rejected":
    case "revoked": {
      const reason = run.level === "revoked" ? run.revoke_reason : run.reason;
      return (
        <Alert variant="destructive" className="mt-6">
          <FileWarning aria-hidden="true" />
          <AlertTitle>
            {run.level === "revoked"
              ? "The Reviewer revoked the verification"
              : "The Reviewer rejected these documents"}
          </AlertTitle>
          <AlertDescription>
            {reason && <p>&ldquo;{reason}&rdquo;</p>}
            <p>Upload new documents below for a new review.</p>
          </AlertDescription>
        </Alert>
      );
    }
    default:
      return null;
  }
}
