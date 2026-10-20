"use client";

import { ArrowLeft, CheckCircle2, Info } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { LoadError } from "@/components/proto/load-error";
import { SiteMap } from "@/components/proto/site-map";
import { StewardPanel as Panel } from "@/components/steward/panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AiSuggestionSlot } from "@/components/verification/ai-suggestion-slot";
import { DecisionForm } from "@/components/verification/decision-form";
import { DocumentPreviews } from "@/components/verification/document-previews";
import { Checklist, VerificationBadge } from "@/components/verification/parts";
import {
  RunDecision,
  RunHistory,
} from "@/components/verification/run-decision";
import type { AssetDetail, VerificationRun } from "@/lib/api/types";
import { boundaryLatLngs, isApiAssetId } from "@/lib/asset-detail";
import { STATUS_LABEL } from "@/lib/community";
import { useAsset, useAssetOutlines } from "@/lib/hooks";
import { outlinePolygons } from "@/lib/listing/boundary";
import { ha } from "@/lib/prototype/format";
import { num } from "@/lib/report-facts";
import {
  currentRun,
  LEVEL_LABEL,
  runBadge,
  type Status,
} from "@/lib/verification";
import {
  useDecideVerification,
  useVerificationRuns,
  type Decision,
} from "@/lib/verification-hooks";

export const QUEUE_HREF = "/admin/verifications";

const DONE: Record<Decision, string> = {
  approve:
    "Approved. The listing is verified and a verification entry is in the Nature Ledger.",
  reject:
    "Rejected. The steward sees your reason and can submit again; the decision is in the Nature Ledger.",
  revoke:
    "Revoked. Trading is suspended until a new submission is approved; both changes are in the Nature Ledger.",
};

/**
 * One listing's review for an admin (T70, ADR-0006 §3): the current run's document previews,
 * checklist and the map, the AI slot, and approve / reject / revoke with a reason.
 */
export function ListingReviewScreen({ assetId }: { assetId: string }) {
  const validId = isApiAssetId(assetId);
  const asset = useAsset(validId ? assetId : undefined);
  const runs = useVerificationRuns(validId ? assetId : undefined);

  let body: React.ReactNode;
  if (!validId || asset.error?.status === 404 || runs.error?.status === 404) {
    body = (
      <Alert className="max-w-2xl">
        <Info aria-hidden="true" />
        <AlertTitle>We couldn&apos;t find this listing</AlertTitle>
        <AlertDescription>
          <p>It may have been removed, or it isn&apos;t in this world.</p>
        </AlertDescription>
      </Alert>
    );
  } else if ((asset.error && !asset.data) || (runs.error && !runs.data)) {
    const error = (asset.error ?? runs.error)!;
    body = (
      <LoadError
        title="We couldn't load this listing's review"
        error={error}
        retry={async () => {
          await Promise.all([asset.refetch(), runs.refetch()]);
        }}
      />
    );
  } else if (!asset.data || !runs.data) {
    body = (
      <p
        role="status"
        className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
      >
        <Spinner aria-hidden="true" role="presentation" />
        Loading the review…
      </p>
    );
  } else {
    body = <Review asset={asset.data} runs={runs.data} />;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pt-8 pb-16 sm:px-6">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-3">
        <Link href={QUEUE_HREF}>
          <ArrowLeft aria-hidden="true" />
          Verification queue
        </Link>
      </Button>
      {body}
    </div>
  );
}

function decisionStatus(run: VerificationRun | null): Status | null {
  if (!run) return null;
  if (run.level === "documents_submitted") return null;
  if (run.effective_level === "verified") return null;
  return {
    title: "No decision to make",
    body:
      run.level === "verified"
        ? "This listing changed after it was approved, so it already counts as unverified; it needs a new submission."
        : `The current run is ${LEVEL_LABEL[run.level].toLowerCase()}. A new submission from the steward will appear in the queue.`,
    tone: "neutral",
  };
}

function Review({
  asset,
  runs,
}: {
  asset: AssetDetail;
  runs: VerificationRun[];
}) {
  const decide = useDecideVerification(asset.id);
  const [pending, setPending] = useState<Decision | null>(null);
  const [done, setDone] = useState<Decision | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const current = currentRun(runs);
  const earlier = runs.filter((run) => run !== current);
  const idle = decisionStatus(current);
  const kind =
    current?.level === "documents_submitted"
      ? "review"
      : current?.effective_level === "verified"
        ? "revoke"
        : null;

  const onDecide = async (decision: Decision, reason: string) => {
    if (!current) return;
    setDone(null);
    setPending(decision);
    const run = await decide.mutate({ decision, runId: current.id, reason });
    setPending(null);
    if (run) setDone(decision);
  };

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Verification review</p>
          <h1 className="mt-1 font-serif text-4xl leading-tight tracking-tight break-words sm:text-5xl">
            {asset.name}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <VerificationBadge
              level={
                current?.level === "revoked"
                  ? "revoked"
                  : (current?.effective_level ?? "unverified")
              }
            >
              {runBadge(current)}
            </VerificationBadge>
            <Badge variant="outline">
              Listing: {STATUS_LABEL[asset.status] ?? asset.status}
            </Badge>
            {current && (
              <Badge variant="outline">
                {current.evidence_kind === "sample"
                  ? "Sample documents (demo)"
                  : "Real documents"}
              </Badge>
            )}
          </div>
        </div>
      </header>

      {done && (
        <Alert ref={doneRef} tabIndex={-1} className="mt-6 outline-none">
          <CheckCircle2 aria-hidden="true" />
          <AlertTitle>Decision recorded</AlertTitle>
          <AlertDescription>
            <p>{DONE[done]}</p>
          </AlertDescription>
        </Alert>
      )}

      {!current ? (
        <p className="mt-8 rounded-3xl bg-card p-8 text-center text-muted-foreground shadow-soft">
          No documents have been submitted for this listing.
        </p>
      ) : (
        <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-6">
            <Panel title="Documents">
              <p className="-mt-2 mb-4 text-sm text-muted-foreground">
                Previews are re-encoded images, never the uploaded file. The
                original only downloads; open it outside the browser if you need
                to.
              </p>
              <DocumentPreviews
                assetId={asset.id}
                documents={current.documents}
              />
            </Panel>
            <Panel title="Automated checks">
              <Checklist items={current.checklist} detailed />
              <p className="mt-4 font-mono text-[11px] break-all text-muted-foreground">
                {current.method_version} · fingerprint{" "}
                {current.input_fingerprint.slice(0, 16)}…
                {current.fingerprint_matches
                  ? " (matches the listing)"
                  : " (the listing changed since)"}
              </p>
            </Panel>
            <AiSuggestionSlot />
            {earlier.length > 0 && (
              <Panel title="Earlier submissions">
                <RunHistory runs={earlier} />
              </Panel>
            )}
          </div>

          <aside className="min-w-0 space-y-6" aria-label="Decision and map">
            <Panel title={kind === "revoke" ? "Revoke" : "Decision"}>
              {kind ? (
                <DecisionForm
                  key={`${current.id}:${current.level}`}
                  run={current}
                  listingName={asset.name}
                  kind={kind}
                  pending={pending}
                  error={decide.error}
                  onDecide={(d, r) => void onDecide(d, r)}
                />
              ) : (
                <div className="text-sm">
                  <p className="font-medium">{idle?.title}</p>
                  <p className="mt-1 text-muted-foreground">{idle?.body}</p>
                </div>
              )}
              {current.level !== "documents_submitted" && (
                <div className="mt-5 border-t border-border pt-4">
                  <RunDecision run={current} />
                </div>
              )}
            </Panel>
            <BoundaryPanel asset={asset} />
          </aside>
        </div>
      )}
    </>
  );
}

function BoundaryPanel({ asset }: { asset: AssetDetail }) {
  const outlines = useAssetOutlines();
  const polygon = useMemo(
    () => boundaryLatLngs(asset.geojson),
    [asset.geojson],
  );
  const others = useMemo(
    () =>
      outlinePolygons(outlines.data?.outlines, asset.id).map((o) => o.polygon),
    [outlines.data, asset.id],
  );
  const area = num(asset.area_ha);
  return (
    <Panel title="Boundary">
      {polygon.length > 2 ? (
        <SiteMap
          polygon={polygon}
          others={others}
          label={asset.name}
          className="h-64"
        />
      ) : (
        <p className="rounded-2xl bg-secondary p-6 text-center text-sm text-muted-foreground">
          No boundary to map.
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {area !== null && `${ha(area)} drawn by the steward. `}
        Dashed outlines are other public listings. Compare the boundary with the
        parcel the documents describe: the checks don&apos;t.
      </p>
    </Panel>
  );
}
