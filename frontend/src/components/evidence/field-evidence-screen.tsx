"use client";

import { ArrowRight, Info, MapPinOff, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  ErrorAlert,
  IpoCard,
  IpoLoading,
  IpoShell,
} from "@/components/ipo-layout";
import { PhotoCard } from "@/components/evidence/photo-card";
import { PhotoUploadForm } from "@/components/evidence/photo-upload-form";
import { useOptionalStewardCommunity } from "@/components/shell/steward-community";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AssetDetail, FieldEvidence, FieldPhoto } from "@/lib/api/types";
import { isApiAssetId } from "@/lib/asset-detail";
import { confidenceStory, reachesListing } from "@/lib/field-evidence";
import { useDeletePhoto, useFieldEvidence } from "@/lib/field-evidence-hooks";
import { useAsset, useSubmitListing } from "@/lib/hooks";
import { NOT_FOUND } from "@/lib/ipo";
import { listingHref } from "@/lib/listing/links";
import { assetHref } from "@/lib/trade";

const CLOSED: ReadonlySet<AssetDetail["status"]> = new Set([
  "withdrawn",
  "ineligible",
]);

const AI_NOTICE: Record<
  FieldEvidence["ai_analysis"],
  { title: string; body: string }
> = {
  model: {
    title: "An AI model labels your photos",
    body: "Photos that pass the location and date checks are read by an image model (MiniCPM-V on Nebius Token Factory). It sees the photo without its location data and only labels what it shows; code decides whether it counts.",
  },
  mock: {
    title: "Demo mode: a stand-in model labels photos",
    body: "Photos that pass the location and date checks get fixed demo labels. Nothing is sent to an AI provider.",
  },
  off: {
    title: "AI analysis is off for now",
    body: "Your photos are stored and checked for location and date, but no photo is sent to an AI model until our provider's data terms are confirmed. Until then they can't count as evidence or raise the rating's confidence.",
  },
};

/** Who sees the photo itself, by AI mode: the model only when it's really on. */
const SENT_TO: Record<FieldEvidence["ai_analysis"], string> = {
  model:
    "To label it, the photo (without location data) is sent to an image model on Nebius Token Factory.",
  mock: "It isn't sent to any AI provider.",
  off: "It isn't sent to any AI model while AI analysis is off.",
};

/**
 * Field evidence for a listing's community (T40, story A4): upload up to 5 geotagged photos,
 * see each photo's checks (location and date in code, labels from an image model) and the
 * fixed confidence effect of validated ones. Every check and number is the API's.
 */
export function FieldEvidenceScreen({ assetId }: { assetId: string }) {
  const validId = isApiAssetId(assetId);
  const asset = useAsset(validId ? assetId : undefined);
  const evidence = useFieldEvidence(validId ? assetId : undefined);
  const steward = useOptionalStewardCommunity();
  const homeHref = steward ? steward.href("/steward") : "/steward";

  const notFound =
    !validId || asset.error?.status === 404 || evidence.error?.status === 404;
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
  const failed = asset.error ?? evidence.error;
  if (failed && (!asset.data || !evidence.data)) {
    return (
      <IpoShell homeHref={homeHref}>
        <ErrorAlert
          title="We couldn't load this listing's field evidence"
          message={failed.message}
          onRetry={() => {
            void asset.refetch();
            void evidence.refetch();
          }}
        />
      </IpoShell>
    );
  }
  if (!asset.data || !evidence.data) {
    return (
      <IpoShell homeHref={homeHref}>
        <IpoLoading>Loading the field evidence…</IpoLoading>
      </IpoShell>
    );
  }
  return (
    <IpoShell homeHref={homeHref}>
      <Loaded
        asset={asset.data}
        evidence={evidence.data}
        communityId={steward?.active?.id ?? asset.data.community_id ?? null}
      />
    </IpoShell>
  );
}

function Loaded({
  asset,
  evidence,
  communityId,
}: {
  asset: AssetDetail;
  evidence: FieldEvidence;
  communityId: string | null;
}) {
  const remove = useDeletePhoto(asset.id);
  const [removing, setRemoving] = useState<string | null>(null);
  const closed = CLOSED.has(asset.status);
  const full = evidence.photos.length >= evidence.max_photos;
  const notice = AI_NOTICE[evidence.ai_analysis];

  const deletePhoto = async (photo: FieldPhoto) => {
    setRemoving(photo.id);
    await remove.mutate(photo.id);
    setRemoving(null);
  };

  return (
    <>
      <header>
        <p className="text-sm text-muted-foreground">Field evidence</p>
        <h1 className="mt-1 font-serif text-4xl leading-tight tracking-tight break-words sm:text-5xl">
          {asset.name}
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Show the land as it is today with up to {evidence.max_photos}{" "}
          geotagged photos. NatureX checks each photo&apos;s location and date
          in code, an image model labels what it shows, and validated photos
          raise the rating&apos;s confidence by a fixed amount.
        </p>
      </header>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <ConfidenceCard
            asset={asset}
            evidence={evidence}
            communityId={communityId}
          />
          <IpoCard aria-labelledby="photos-heading">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="photos-heading" className="text-lg font-semibold">
                Your photos
              </h2>
              <p className="text-sm text-muted-foreground tabular-nums">
                {evidence.photos.length} of {evidence.max_photos} ·{" "}
                {evidence.validated} validated
              </p>
            </div>
            {evidence.photos.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No photos yet. Upload one taken on the land with your
                phone&apos;s location turned on.
              </p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {evidence.photos.map((photo, i) => (
                  <li key={photo.id}>
                    <PhotoCard
                      assetId={asset.id}
                      photo={photo}
                      index={i + 1}
                      onDelete={(p) => void deletePhoto(p)}
                      deleting={removing === photo.id}
                    />
                  </li>
                ))}
              </ul>
            )}
            {remove.error && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                The photo wasn&apos;t deleted: {remove.error.message}
              </p>
            )}
          </IpoCard>
        </div>

        <div className="min-w-0 space-y-6">
          {closed && (
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>This listing doesn&apos;t take photos</AlertTitle>
              <AlertDescription>
                <p>It&apos;s withdrawn or not eligible.</p>
              </AlertDescription>
            </Alert>
          )}
          <IpoCard aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="text-lg font-semibold">
              Upload a photo
            </h2>
            <p className="mt-1 mb-5 text-sm text-muted-foreground">
              A wide view of the land, water or vegetation works best.
            </p>
            <div className="mb-5 space-y-3">
              <Alert role="note">
                <MapPinOff aria-hidden="true" />
                <AlertTitle>Your location stays private</AlertTitle>
                <AlertDescription>
                  <p>
                    The photo&apos;s GPS position and date are read once to
                    check them against the boundary; only the result is kept.
                    The photo is stored without any location data, and only your
                    community and NatureX admins can see it.{" "}
                    {SENT_TO[evidence.ai_analysis]} The public sees counts,
                    labels and the month of your latest photo, never the photos.
                  </p>
                </AlertDescription>
              </Alert>
              <Alert role="note" data-ai-analysis={evidence.ai_analysis}>
                <Sparkles aria-hidden="true" />
                <AlertTitle>{notice.title}</AlertTitle>
                <AlertDescription>
                  <p>{notice.body}</p>
                </AlertDescription>
              </Alert>
            </div>
            {full && !closed ? (
              <p className="text-sm text-muted-foreground">
                This listing has {evidence.max_photos} photos, the most it can
                hold. Delete one to add another.
              </p>
            ) : (
              <PhotoUploadForm assetId={asset.id} disabled={closed} />
            )}
          </IpoCard>
        </div>
      </div>
    </>
  );
}

function ConfidenceCard({
  asset,
  evidence,
  communityId,
}: {
  asset: AssetDetail;
  evidence: FieldEvidence;
  communityId: string | null;
}) {
  const story = confidenceStory(evidence);
  const submit = useSubmitListing();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    if (submitted) headingRef.current?.focus();
  }, [submitted]);
  // Only when the projection reaches the gate: otherwise the new rating would leave the
  // listing needing evidence again (the story explains why).
  const canResubmit =
    asset.status === "needs_evidence" &&
    evidence.validated > 0 &&
    !evidence.confidence.counted &&
    reachesListing(evidence);
  const onExchange = asset.status === "listed" || asset.status === "suspended";

  const resubmit = async () => {
    const done = await submit.mutate(asset.id);
    if (done) setSubmitted(true);
  };

  return (
    <IpoCard aria-labelledby="effect-heading">
      <p className="text-sm text-muted-foreground">Effect on the rating</p>
      <h2
        id="effect-heading"
        ref={headingRef}
        tabIndex={-1}
        className="mt-1 font-serif text-3xl leading-tight tabular-nums outline-none"
      >
        {submitted ? "Rating again with your photos" : story.title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {submitted
          ? "The agents are rating the listing with your validated photos. Follow it on the listing page."
          : story.body}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {canResubmit && !submitted && (
          <Button onClick={() => void resubmit()} disabled={submit.isPending}>
            {submit.isPending ? "Submitting…" : "Submit for a new rating"}
          </Button>
        )}
        {submitted && communityId && (
          <Button asChild>
            <Link href={listingHref(communityId, asset.id)}>
              Follow the rating
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        )}
        {onExchange && (
          <Button asChild variant="outline">
            <Link href={`${assetHref(asset.id)}#field-evidence`}>
              See the public field evidence
            </Link>
          </Button>
        )}
      </div>
      {submit.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {submit.error.message}
        </p>
      )}
    </IpoCard>
  );
}
