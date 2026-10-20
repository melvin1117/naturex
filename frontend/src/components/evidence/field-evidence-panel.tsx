"use client";

import { Camera } from "lucide-react";

import { LoadError } from "@/components/proto/load-error";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { FieldEvidencePublic } from "@/lib/api/types";
import {
  DISTURBANCE_LABEL,
  LAND_COVER_LABEL,
  shortDate,
} from "@/lib/field-evidence";
import { useFieldEvidenceSummary } from "@/lib/field-evidence-hooks";

export const FIELD_EVIDENCE_PANEL_ID = "field-evidence";

/**
 * Field evidence on the public asset page (T40): counts and labels of the community's
 * validated photos only. Never a photo, a position or who took it.
 */
export function FieldEvidencePanel({ assetId }: { assetId: string }) {
  const summary = useFieldEvidenceSummary(assetId);
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
    </section>
  );
}

function Summary({ summary }: { summary: FieldEvidencePublic }) {
  if (summary.validated === 0)
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        {summary.photos === 0
          ? "The community hasn't added field photos yet."
          : "None of the community's field photos has passed the checks yet."}
      </p>
    );
  return (
    <div className="mt-3 space-y-4">
      <p className="text-sm text-muted-foreground">
        {summary.validated === 1
          ? "1 geotagged photo"
          : `${summary.validated} geotagged photos`}{" "}
        taken on the listing&apos;s land
        {summary.latest_taken_on
          ? `, the latest on ${shortDate(summary.latest_taken_on)}`
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
