"use client";

import { Upload } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { focusIfLost } from "@/components/steward/focus";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { FieldPhoto } from "@/lib/api/types";
import {
  PHOTO_ACCEPT,
  photoFileProblem,
  photoUploadFailure,
} from "@/lib/field-evidence";
import { useUploadPhoto } from "@/lib/field-evidence-hooks";

type Field = "file" | "consent";

/**
 * Upload one geotagged field photo (JPEG or PNG, ≤ 10 MB) as taken, with its EXIF: the
 * backend reads the position and date, then stores the photo without them. The same rules the
 * backend applies are checked first; the backend decides.
 */
export function PhotoUploadForm({
  assetId,
  disabled = false,
  onUploaded,
}: {
  assetId: string;
  disabled?: boolean;
  onUploaded?: (photo: FieldPhoto) => void;
}) {
  const id = useId();
  const upload = useUploadPhoto(assetId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [done, setDone] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Partial<Record<Field, string>> = {};
    const problem = photoFileProblem(file);
    if (problem) next.file = problem;
    if (!consent)
      next.consent =
        "Confirm you took this photo on the land and may share it.";
    setErrors(next);
    setDone(null);
    const first = (["file", "consent"] as const).find((f) => next[f]);
    if (first) {
      globalThis.document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    if (!file) return;
    const photo = await upload.mutate(file);
    if (!photo) return;
    setDone(
      photo.analysis_status === "pending"
        ? "Uploaded. The location and date passed; the image model is reading it."
        : "Uploaded. See its checks below.",
    );
    setFile(null);
    setConsent(false);
    if (fileRef.current) fileRef.current.value = "";
    onUploaded?.(photo);
  };

  const pending = upload.isPending;
  // The submit button disables while uploading, which drops focus: give it back after.
  const submitRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) focusIfLost(submitRef.current);
    wasPending.current = pending;
  }, [pending]);
  const errorId = (field: Field) => `${id}-${field}-error`;

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor={`${id}-file`}>Photo</Label>
        <Input
          ref={fileRef}
          id={`${id}-file`}
          name="photo"
          type="file"
          accept={PHOTO_ACCEPT}
          disabled={disabled || pending}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-invalid={Boolean(errors.file)}
          aria-describedby={`${id}-file-hint${errors.file ? ` ${errorId("file")}` : ""}`}
          className="h-auto py-2"
        />
        <p id={`${id}-file-hint`} className="text-xs text-muted-foreground">
          JPEG or PNG straight from the camera, up to 10 MB, with location on.
          Taken inside the boundary (or within 100 m of it) in the last year.
        </p>
        {errors.file && (
          <p id={errorId("file")} className="text-sm text-destructive">
            {errors.file}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-start gap-3">
          <Checkbox
            id={`${id}-consent`}
            checked={consent}
            onCheckedChange={(v) => setConsent(v === true)}
            disabled={disabled || pending}
            aria-invalid={Boolean(errors.consent)}
            aria-describedby={errors.consent ? errorId("consent") : undefined}
            className="mt-0.5"
          />
          <Label htmlFor={`${id}-consent`} className="leading-snug font-normal">
            I took this photo on this land and may share it. NatureX reads its
            GPS position and date to check them, keeps only the result, and
            stores the photo without location data.
          </Label>
        </div>
        {errors.consent && (
          <p id={errorId("consent")} className="text-sm text-destructive">
            {errors.consent}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button ref={submitRef} type="submit" disabled={disabled || pending}>
          {pending ? (
            <Spinner aria-hidden="true" role="presentation" />
          ) : (
            <Upload aria-hidden="true" />
          )}
          {pending ? "Checking the photo…" : "Upload photo"}
        </Button>
        <div aria-live="polite" className="text-sm">
          {done && <p className="text-lime-ink">{done}</p>}
        </div>
      </div>
      {upload.error && (
        <p role="alert" className="text-sm text-destructive">
          {photoUploadFailure(upload.error)}
        </p>
      )}
    </form>
  );
}
