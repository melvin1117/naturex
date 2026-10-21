"use client";

import {
  CircleCheck,
  CircleMinus,
  CircleX,
  ImageOff,
  Trash2,
} from "lucide-react";
import { cn } from "cn";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { FieldPhoto } from "@/lib/api/types";
import {
  photoChecks,
  photoVerdict,
  reasonText,
  shortDate,
  VERDICT_LABEL,
  type CheckState,
  type PhotoVerdict,
} from "@/lib/field-evidence";
import { useFieldPhotoImage } from "@/lib/field-evidence-hooks";

const VERDICT_TONE: Record<PhotoVerdict, string> = {
  validated: "bg-lime/35 text-lime-ink",
  checking: "bg-secondary text-secondary-foreground",
  not_counted: "bg-clay/15 text-clay-ink",
};

const STATE_ICON = {
  pass: CircleCheck,
  fail: CircleX,
  skipped: CircleMinus,
  pending: null,
} satisfies Record<CheckState, unknown>;

const STATE_TONE: Record<CheckState, string> = {
  pass: "text-lime-ink",
  fail: "text-destructive",
  skipped: "text-muted-foreground",
  pending: "text-muted-foreground",
};

const STATE_WORD: Record<CheckState, string> = {
  pass: "Passed",
  fail: "Failed",
  skipped: "Not run",
  pending: "Running",
};

// Reasons the location and date rows already explain.
const GEOTAG_REASONS = new Set([
  "gps_missing",
  "gps_outside",
  "taken_missing",
  "taken_future",
  "taken_too_old",
  "not_analysed",
]);

/**
 * One field photo for its steward: the stored image (re-encoded, no location data), each
 * check's result in words and icons (never colour alone), and whether it counts as evidence.
 */
export function PhotoCard({
  assetId,
  photo,
  index,
  onDelete,
  deleting,
}: {
  assetId: string;
  photo: FieldPhoto;
  index: number;
  onDelete: (photo: FieldPhoto) => void;
  deleting: boolean;
}) {
  const verdict = photoVerdict(photo);
  const extra = photo.reasons.filter((r) => !GEOTAG_REASONS.has(r));
  return (
    <figure
      className="overflow-hidden rounded-2xl border border-border bg-card"
      aria-labelledby={`photo-${photo.id}-title`}
    >
      <PhotoImage assetId={assetId} photo={photo} index={index} />
      <figcaption className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={`photo-${photo.id}-title`} className="font-medium">
            Photo {index}
          </p>
          <Badge
            variant="secondary"
            data-verdict={verdict}
            className={cn("px-2.5 py-1", VERDICT_TONE[verdict])}
          >
            {verdict === "checking" && (
              <Spinner aria-hidden="true" role="presentation" />
            )}
            {VERDICT_LABEL[verdict]}
          </Badge>
        </div>
        <ul aria-label={`Checks of photo ${index}`} className="space-y-2">
          {photoChecks(photo).map((check) => {
            const Icon = STATE_ICON[check.state];
            return (
              <li key={check.id} className="flex items-start gap-2 text-sm">
                <span
                  className={cn("mt-0.5 shrink-0", STATE_TONE[check.state])}
                >
                  {Icon ? (
                    <Icon className="size-4" aria-hidden="true" />
                  ) : (
                    <Spinner aria-hidden="true" role="presentation" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="font-medium">{check.label}</span>
                  <span className="sr-only">: {STATE_WORD[check.state]}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {check.detail}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        {verdict === "not_counted" && extra.length > 0 && (
          <ul className="space-y-1 text-sm text-clay-ink">
            {extra.map((reason) => (
              <li key={reason}>{reasonText(reason)}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <p className="text-xs text-muted-foreground">
            Uploaded {shortDate(photo.created_at)}
          </p>
          <DeletePhoto
            photo={photo}
            index={index}
            onDelete={onDelete}
            deleting={deleting}
          />
        </div>
      </figcaption>
    </figure>
  );
}

/** Delete, after a confirmation: the photo and its evidence go for good. */
function DeletePhoto({
  photo,
  index,
  onDelete,
  deleting,
}: {
  photo: FieldPhoto;
  index: number;
  onDelete: (photo: FieldPhoto) => void;
  deleting: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={deleting}
          aria-label={`Delete photo ${index}`}
        >
          <Trash2 aria-hidden="true" />
          {deleting ? "Deleting…" : "Delete"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete photo {index}?</AlertDialogTitle>
          <AlertDialogDescription>
            {photo.validated
              ? "The photo and its evidence are removed, so the next rating won't count it. A rating already made keeps what it cited."
              : "The photo is removed for good."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => onDelete(photo)}
          >
            Delete photo
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PhotoImage({
  assetId,
  photo,
  index,
}: {
  assetId: string;
  photo: FieldPhoto;
  index: number;
}) {
  const image = useFieldPhotoImage(assetId, photo.id);
  return (
    <div className="grid aspect-[4/3] place-items-center bg-secondary/60">
      {image.url ? (
        // A blob URL of the API's re-encoded JPEG; next/image can't optimise it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.url}
          alt={`Field photo ${index}`}
          width={photo.width}
          height={photo.height}
          loading="lazy"
          className="size-full object-cover"
        />
      ) : image.error ? (
        <p
          role="alert"
          className="flex flex-col items-center gap-2 p-4 text-center text-xs text-destructive"
        >
          <ImageOff className="size-5" aria-hidden="true" />
          The photo didn&apos;t load.
        </p>
      ) : (
        <p
          role="status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Spinner aria-hidden="true" role="presentation" />
          Loading photo…
        </p>
      )}
    </div>
  );
}
