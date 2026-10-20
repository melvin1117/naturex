"use client";

import { ArrowRight, Info } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import {
  ErrorAlert,
  IpoCard,
  IpoLoading,
  IpoShell,
} from "@/components/ipo-layout";
import { useOptionalStewardCommunity } from "@/components/shell/steward-community";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DocumentSubmitList } from "@/components/verification/document-submit-list";
import { DocumentUploadForm } from "@/components/verification/document-upload-form";
import { Checklist, VerificationBadge } from "@/components/verification/parts";
import {
  RunDecision,
  RunHistory,
} from "@/components/verification/run-decision";
import type {
  AssetDetail,
  VerificationPublic,
  VerificationRun,
} from "@/lib/api/types";
import { isApiAssetId } from "@/lib/asset-detail";
import { useAsset } from "@/lib/hooks";
import { NOT_FOUND } from "@/lib/ipo";
import { ipoHref } from "@/lib/listing/links";
import { assetHref } from "@/lib/trade";
import {
  currentRun,
  MAX_RUN_DOCUMENTS,
  stewardStatus,
  type Tone,
} from "@/lib/verification";
import {
  useListingDocuments,
  useSubmitVerification,
  useVerificationPanel,
  useVerificationRuns,
} from "@/lib/verification-hooks";

const CLOSED: ReadonlySet<AssetDetail["status"]> = new Set([
  "withdrawn",
  "ineligible",
]);

/**
 * The steward's verification screen (T70, story A9): upload land documents, submit them for
 * review, and read the checklist and the reviewer's decision. Every level, check and reason
 * is the API's (T69); the backend authorizes each step.
 */
export function StewardVerifyScreen({ assetId }: { assetId: string }) {
  const validId = isApiAssetId(assetId);
  const asset = useAsset(validId ? assetId : undefined);
  const runs = useVerificationRuns(validId ? assetId : undefined);
  const steward = useOptionalStewardCommunity();
  const homeHref = steward ? steward.href("/steward") : "/steward";

  const notFound =
    !validId || asset.error?.status === 404 || runs.error?.status === 404;
  if (notFound) {
    return (
      <IpoShell homeHref={homeHref}>
        <Alert className="max-w-2xl">
          <Info aria-hidden="true" />
          <AlertTitle>{NOT_FOUND.title}</AlertTitle>
          <AlertDescription>
            <p>{NOT_FOUND.body}</p>
          </AlertDescription>
        </Alert>
      </IpoShell>
    );
  }
  const failed = asset.error ?? runs.error;
  if (failed && (!asset.data || !runs.data)) {
    return (
      <IpoShell homeHref={homeHref}>
        <ErrorAlert
          title="We couldn't load this listing's verification"
          message={failed.message}
          onRetry={() => {
            void asset.refetch();
            void runs.refetch();
          }}
        />
      </IpoShell>
    );
  }
  if (!asset.data || !runs.data) {
    return (
      <IpoShell homeHref={homeHref}>
        <IpoLoading>Loading the verification record…</IpoLoading>
      </IpoShell>
    );
  }
  return (
    <IpoShell homeHref={homeHref}>
      <Loaded
        asset={asset.data}
        runs={runs.data}
        communityId={steward?.active?.id ?? null}
      />
    </IpoShell>
  );
}

function Loaded({
  asset,
  runs,
  communityId,
}: {
  asset: AssetDetail;
  runs: VerificationRun[];
  communityId: string | null;
}) {
  const documents = useListingDocuments(asset.id);
  // The public record says what stands (the asset's revocation included); runs alone can't.
  const panel = useVerificationPanel(asset.id);
  const submit = useSubmitVerification(asset.id);
  const [selected, setSelected] = useState<string[]>([]);
  const statusRef = useRef<HTMLHeadingElement>(null);
  const [focusStatus, setFocusStatus] = useState(false);
  useEffect(() => {
    if (!focusStatus) return;
    statusRef.current?.focus();
    setFocusStatus(false);
  }, [focusStatus]);

  const current = currentRun(runs);
  const earlier = runs.filter((run) => run !== current);
  const closed = CLOSED.has(asset.status);
  // Only an approval lifts a revocation (`assets.verification_revoked_at`), not a newer
  // submission; when the current run is the revoked one, its status already says so.
  const revocationStands =
    panel.data?.level === "revoked" && current?.level !== "revoked";

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) =>
      on
        ? prev.includes(id) || prev.length >= MAX_RUN_DOCUMENTS
          ? prev
          : [...prev, id]
        : prev.filter((x) => x !== id),
    );
  const send = async () => {
    const run = await submit.mutate(selected);
    if (!run) return;
    setSelected([]);
    setFocusStatus(true);
  };

  return (
    <>
      <header>
        <p className="text-sm text-muted-foreground">Listing verification</p>
        <h1 className="mt-1 font-serif text-4xl leading-tight tracking-tight break-words sm:text-5xl">
          {asset.name}
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Show the Exchange why your community may list this land. Upload your
          documents and submit them; automated checks run at once and a NatureX
          reviewer decides. On the live Exchange, the opening offer needs a
          verified listing.
        </p>
      </header>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <StatusCard
            run={current}
            record={panel.data}
            asset={asset}
            communityId={communityId}
            revocationStands={revocationStands}
            headingRef={statusRef}
          />
          {current && (
            <IpoCard aria-labelledby="checks-heading">
              <h2 id="checks-heading" className="text-lg font-semibold">
                Automated checks
              </h2>
              <p className="mt-1 mb-4 text-sm text-muted-foreground">
                From your latest submission. A reviewer reads these with your
                documents; a failed check can&apos;t be approved.
              </p>
              <Checklist items={current.checklist} detailed />
            </IpoCard>
          )}
          {earlier.length > 0 && (
            <IpoCard aria-labelledby="history-heading">
              <h2 id="history-heading" className="mb-4 text-lg font-semibold">
                Earlier submissions
              </h2>
              <RunHistory runs={earlier} />
            </IpoCard>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {closed && (
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>This listing can&apos;t be verified</AlertTitle>
              <AlertDescription>
                <p>
                  It&apos;s withdrawn or not eligible, so it doesn&apos;t take
                  new documents.
                </p>
              </AlertDescription>
            </Alert>
          )}
          <IpoCard aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="text-lg font-semibold">
              Upload a document
            </h2>
            <p className="mt-1 mb-5 text-sm text-muted-foreground">
              For example a land title or agrarian certificate, the assembly
              minutes approving the listing, or the cooperative or ejido
              registration.
            </p>
            <DocumentUploadForm
              assetId={asset.id}
              disabled={closed}
              onUploaded={(doc) => toggle(doc.id, true)}
            />
          </IpoCard>
          <IpoCard aria-labelledby="documents-heading">
            <h2 id="documents-heading" className="mb-4 text-lg font-semibold">
              Your documents
            </h2>
            {documents.data ? (
              <DocumentSubmitList
                documents={documents.data}
                selected={selected}
                onToggle={toggle}
                onSubmit={() => void send()}
                pending={submit.isPending}
                error={submit.error}
                disabled={closed}
              />
            ) : documents.error ? (
              <ErrorAlert
                title="We couldn't load your documents"
                message={documents.error.message}
                onRetry={() => void documents.refetch()}
              />
            ) : (
              <IpoLoading>Loading your documents…</IpoLoading>
            )}
          </IpoCard>
        </div>
      </div>
    </>
  );
}

const TONE: Record<Tone, string> = {
  neutral: "",
  pending: "",
  positive: "ring-1 ring-lime-ink/30",
  negative: "ring-1 ring-clay/40",
};

function StatusCard({
  run,
  record,
  asset,
  communityId,
  revocationStands,
  headingRef,
}: {
  run: VerificationRun | null;
  /** The public record: its badge is the Exchange's wording. */
  record: VerificationPublic | undefined;
  asset: AssetDetail;
  communityId: string | null;
  revocationStands: boolean;
  headingRef: React.Ref<HTMLHeadingElement>;
}) {
  const status = stewardStatus(run);
  const canLaunch =
    record?.level === "verified" && asset.status === "listed" && !asset.trading;
  const onExchange = asset.status === "listed" || asset.status === "suspended";
  return (
    <IpoCard aria-labelledby="status-heading" className={cn(TONE[status.tone])}>
      {record && (
        <VerificationBadge level={record.level}>
          {record.badge}
        </VerificationBadge>
      )}
      <h2
        id="status-heading"
        ref={headingRef}
        tabIndex={-1}
        className="mt-3 font-serif text-3xl leading-tight outline-none"
      >
        {status.title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">{status.body}</p>
      {revocationStands && (
        <p className="mt-3 text-sm font-medium text-clay-ink">
          A revocation still stands: trading stays paused until a reviewer
          approves a new submission.
        </p>
      )}
      {run && (
        <div className="mt-5">
          <RunDecision run={run} />
        </div>
      )}
      {(canLaunch || onExchange) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {canLaunch && (
            <Button asChild>
              <Link href={ipoHref(asset.id, communityId)}>
                Launch the opening offer
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          )}
          {onExchange && (
            <Button asChild variant="outline">
              <Link href={`${assetHref(asset.id)}#verification`}>
                See the public verification panel
              </Link>
            </Button>
          )}
        </div>
      )}
    </IpoCard>
  );
}
