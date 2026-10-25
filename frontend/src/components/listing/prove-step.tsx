"use client";

import { ArrowRight, FileCheck2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { DocumentUploadForm } from "@/components/verification/document-upload-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AssetDetail } from "@/lib/api/types";
import {
  DOC_TYPE_LABEL,
  MAX_RUN_DOCUMENTS,
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
  onContinue,
}: {
  asset: AssetDetail;
  onContinue: () => void;
}) {
  const runs = useVerificationRuns(asset.id);
  const submit = useSubmitVerification(asset.id);
  const waiting = runs.data ? waitingRun(runs.data) : null;
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
        <div className="mt-6 max-w-xl">
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
            <p>{submit.error.message}</p>
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3">
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
