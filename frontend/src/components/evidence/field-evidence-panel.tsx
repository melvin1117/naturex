"use client";

import { Camera } from "lucide-react";
import Link from "@/components/app-link";

import { LoadError } from "@/components/proto/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { FieldEvidencePublic } from "@/lib/api/types";
import {
  DISTURBANCE_LABEL,
  evidenceHref,
  LAND_COVER_LABEL,
  monthYear,
} from "@/lib/field-evidence";
import { useFieldEvidenceSummary } from "@/lib/field-evidence-hooks";
import { useMyCommunities } from "@/lib/hooks";

export const FIELD_EVIDENCE_PANEL_ID = "field-evidence";

/**
 * Field evidence on the public asset page (T40): counts and labels of the community's
 * validated photos only. Never a photo, a position or who took it. It says what field evidence
 * is and how it's added; members of the site's community get a link to add photos (#214).
 */
export function FieldEvidencePanel({
  assetId,
  communityId,
}: {
  assetId: string;
  /** The listing's community, so its members get the "Add field photos" link. */
  communityId: string | null;
}) {
  const summary = useFieldEvidenceSummary(assetId);
  const communities = useMyCommunities();
  const addHref =
    communityId !== null &&
    (communities.data ?? []).some((c) => c.id === communityId)
      ? evidenceHref(assetId, communityId)
      : null;
  return (
    <section
      id={FIELD_EVIDENCE_PANEL_ID}
      aria-labelledby="field-evidence-heading"
      className="scroll-mt-24 rounded-3xl bg-card p-6 shadow-soft sm:p-8"
    >
      <h2
        id="field-evidence-heading"
        className="flex items-center gap-2 font-serif text-3xl"
      >
        <Camera className="size-6 text-muted-foreground" aria-hidden="true" />
        Field evidence
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-pretty text-muted-foreground">
        Geotagged photos from the site&apos;s community, checked against its
        boundary, can raise the rating&apos;s confidence.
      </p>
      {summary.data ? (
        <Summary summary={summary.data} />
      ) : summary.error ? (
        <div className="mt-4">
          <LoadError
            title="We couldn't load the field evidence"
            error={summary.error}
            retry={summary.refetch}
          />
        </div>
      ) : (
        <p
          role="status"
          className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner aria-hidden="true" role="presentation" />
          Loading the field evidence…
        </p>
      )}
      {addHref && (
        <Button asChild variant="outline" size="sm" className="mt-5">
          <Link href={addHref}>
            <Camera aria-hidden="true" />
            Add field photos
          </Link>
        </Button>
      )}
    </section>
  );
}

function Summary({ summary }: { summary: FieldEvidencePublic }) {
  if (summary.validated === 0)
    return (
      <p className="mt-4 text-sm">
        {summary.photos === 0
          ? "No field photos yet. Members of the site's community add them from Communities: photos taken on the land in the last year, with the phone's location on."
          : "None of the community's field photos has passed the checks yet."}
      </p>
    );
  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm">
        {summary.validated === 1
          ? "1 geotagged photo"
          : `${summary.validated} geotagged photos`}{" "}
        taken on the listing&apos;s land
        {summary.latest_taken_month
          ? `, the latest in ${monthYear(summary.latest_taken_month)}`
          : ""}
        , passed the location and date checks and an image model&apos;s review.{" "}
        {summary.counted_in_latest_report
          ? "The latest rating counts them in its confidence."
          : "They count from the next rating."}
      </p>
      <LabelRow
        title="Seen on the land"
        labels={summary.land_cover.map((c) => LAND_COVER_LABEL[c])}
      />
      <LabelRow
        title="Signs of disturbance"
        labels={summary.disturbance.map((d) => DISTURBANCE_LABEL[d])}
        empty="None seen"
      />
      <p className="text-xs text-muted-foreground">
        The photos stay private to the community; their location is never
        stored. Labels come from an image model and only decide whether a photo
        counts, never a score.
      </p>
    </div>
  );
}

function LabelRow({
  title,
  labels,
  empty = "—",
}: {
  title: string;
  labels: string[];
  empty?: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      {labels.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label={title}>
          {labels.map((label) => (
            <li key={label}>
              <Badge variant="secondary" className="px-2.5 py-1">
                {label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
