"use client";

import { Upload } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { focusIfLost } from "@/components/steward/focus";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { DocumentType, ListingDocument } from "@/lib/api/types";
import {
  ACCEPT_ATTRIBUTE,
  DOC_TYPE_LABEL,
  DOC_TYPES,
  fileProblem,
  uploadFailure,
} from "@/lib/verification";
import { useUploadDocument } from "@/lib/verification-hooks";

type Field = "type" | "file" | "consent";

/**
 * Upload one land document (PDF, JPEG or PNG, ≤ 5 MB). The same rules the backend applies are
 * checked first so the steward learns at once; the backend's inspection decides.
 */
export function DocumentUploadForm({
  assetId,
  disabled = false,
  onUploaded,
}: {
  assetId: string;
  disabled?: boolean;
  onUploaded: (document: ListingDocument) => void;
}) {
  const id = useId();
  const upload = useUploadDocument(assetId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<DocumentType | "">("");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [done, setDone] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Partial<Record<Field, string>> = {};
    if (!docType) next.type = "Choose what the document is.";
    const problem = fileProblem(file);
    if (problem) next.file = problem;
    if (!consent)
      next.consent = "Confirm you're authorised to share this document.";
    setErrors(next);
    setDone(null);
    const first = (["type", "file", "consent"] as const).find((f) => next[f]);
    if (first) {
      globalThis.document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    if (!file || !docType) return;
    const document = await upload.mutate({ file, docType });
    if (!document) return;
    setDone(`Uploaded: ${DOC_TYPE_LABEL[document.doc_type]}.`);
    setDocType("");
    setFile(null);
    setConsent(false);
    if (fileRef.current) fileRef.current.value = "";
    onUploaded(document);
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
        <Label htmlFor={`${id}-type`}>What is it?</Label>
        <Select
          value={docType}
          onValueChange={(value) => setDocType(value as DocumentType)}
          disabled={disabled || pending}
        >
          <SelectTrigger
            id={`${id}-type`}
            className="w-full sm:w-80"
            aria-invalid={Boolean(errors.type)}
            aria-describedby={errors.type ? errorId("type") : undefined}
          >
            <SelectValue placeholder="Choose a document type…" />
          </SelectTrigger>
          <SelectContent>
            {DOC_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {DOC_TYPE_LABEL[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.type && (
          <p id={errorId("type")} className="text-sm text-destructive">
            {errors.type}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-file`}>File</Label>
        <Input
          ref={fileRef}
          id={`${id}-file`}
          name="document"
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          disabled={disabled || pending}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-invalid={Boolean(errors.file)}
          aria-describedby={`${id}-file-hint${errors.file ? ` ${errorId("file")}` : ""}`}
          className="h-auto py-2"
        />
        <p id={`${id}-file-hint`} className="text-xs text-muted-foreground">
          PDF, JPEG or PNG, up to 5 MB and 50 pages. Encrypted PDFs and PDFs
          with scripts or forms aren&apos;t accepted.
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
            I&apos;m authorised to share this document. Only this
            community&apos;s members and NatureX reviewers can open it; the
            public sees check results, never the document.
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
          {pending ? "Checking the file…" : "Upload document"}
        </Button>
        <div aria-live="polite" className="text-sm">
          {done && <p className="text-lime-ink">{done}</p>}
        </div>
      </div>
      {upload.error && (
        <p role="alert" className="text-sm text-destructive">
          {uploadFailure(upload.error)}
        </p>
      )}
    </form>
  );
}
