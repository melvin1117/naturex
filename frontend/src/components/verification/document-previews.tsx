"use client";

import { Download, FileText } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import type { ListingDocument } from "@/lib/api/types";
import { date } from "@/lib/prototype/format";
import {
  DOC_TYPE_LABEL,
  documentDownloadUrl,
  documentFacts,
} from "@/lib/verification";
import { useDocumentPreview } from "@/lib/verification-hooks";

/**
 * A run's documents for the reviewer: each as its sanitised, re-encoded PNG preview (never the
 * original bytes in the page, ADR-0006 §2), with the original available only as a download.
 */
export function DocumentPreviews({
  assetId,
  documents,
}: {
  assetId: string;
  documents: readonly ListingDocument[];
}) {
  if (documents.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No documents in this run.</p>
    );
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {documents.map((doc) => (
        <li key={doc.id}>
          <DocumentPreview assetId={assetId} document={doc} />
        </li>
      ))}
    </ul>
  );
}

function DocumentPreview({
  assetId,
  document,
}: {
  assetId: string;
  document: ListingDocument;
}) {
  const preview = useDocumentPreview(assetId, document);
  const label = DOC_TYPE_LABEL[document.doc_type];
  return (
    <figure className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="grid aspect-[4/3] place-items-center bg-secondary/60">
        {!document.has_preview ? (
          <div className="flex flex-col items-center gap-2 p-4 text-center text-xs text-muted-foreground">
            <FileText className="size-6" aria-hidden="true" />
            No preview: this PDF&apos;s first page holds no scanned image.
          </div>
        ) : preview.url ? (
          // A blob URL of the API's re-encoded PNG; next/image can't optimise it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview.url}
            alt={`Preview of the ${label.toLowerCase()}`}
            className="size-full object-contain"
          />
        ) : preview.error ? (
          <p role="alert" className="p-4 text-center text-xs text-destructive">
            The preview didn&apos;t load: {preview.error.message}
          </p>
        ) : (
          <p
            role="status"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Spinner aria-hidden="true" role="presentation" />
            Loading preview…
          </p>
        )}
      </div>
      <figcaption className="space-y-1 p-3 text-sm">
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {documentFacts(document)} · uploaded {date(document.created_at)}
        </p>
        <a
          href={documentDownloadUrl(assetId, document.id)}
          download
          aria-label={`Download the original ${label.toLowerCase()}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-4"
        >
          <Download className="size-3.5" aria-hidden="true" />
          Download the original
        </a>
      </figcaption>
    </figure>
  );
}
