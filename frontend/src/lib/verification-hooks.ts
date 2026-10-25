/**
 * Data hooks for listing verification (T70 over the T69 API, ADR-0006). Same contract as
 * ./hooks.ts: queries give `{ data, error, isLoading, refetch }`, mutations
 * `{ mutate, mutateAsync, isPending, error }`, and every error is an `ApiError`.
 */
import { useCallback, useEffect, useState } from "react";

import { AI_POLL_MS } from "./ai-suggestion";
import { unwrap } from "./api/errors";
import type {
  DecidedListingItem,
  DocumentType,
  ListingDocument,
  ReviewQueueItem,
  VerificationPublic,
  VerificationRun,
} from "./api/types";
import { queryKeys, useDataLayer, type DataLayer } from "./data-layer";
import {
  useApiMutation,
  useApiQuery,
  useWorld,
  type MutationResult,
  type QueryResult,
} from "./hooks";

/** "How this listing was verified": public, for anyone who can see the asset. */
export function useVerificationPanel(
  assetId: string | undefined,
): QueryResult<VerificationPublic> {
  return useApiQuery(
    queryKeys.verificationPanel(assetId ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/verification", {
          params: { path: { asset_id: assetId ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(assetId) },
  );
}

/** Every run of a listing, newest first (its community's members and same-world admins). */
export function useVerificationRuns(
  assetId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): QueryResult<VerificationRun[]> {
  return useApiQuery(
    queryKeys.verificationRuns(assetId ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/verification/runs", {
          params: { path: { asset_id: assetId ?? "" } },
          signal,
        }),
      ),
    { enabled: enabled && Boolean(assetId) },
  );
}

/**
 * A document's sanitised PNG preview as an object URL (revoked on unmount), never the
 * original bytes. Idle when the document has no preview.
 */
export function useDocumentPreview(
  assetId: string,
  document: Pick<ListingDocument, "id" | "has_preview">,
): {
  url: string | null;
  error: QueryResult<Blob>["error"];
  isLoading: boolean;
} {
  const query = useApiQuery(
    queryKeys.documentPreview(assetId, document.id),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/documents/{document_id}/preview", {
          params: { path: { asset_id: assetId, document_id: document.id } },
          parseAs: "blob",
          signal,
        }),
      ) as Promise<Blob>,
    { enabled: document.has_preview },
  );
  const [url, setUrl] = useState<string | null>(null);
  const blob = query.data;
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") return;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [blob]);
  return { url, error: query.error, isLoading: query.isLoading };
}

function afterVerificationChange(assetId: string, { cache }: DataLayer) {
  cache.invalidate(queryKeys.verification(assetId));
  cache.invalidate(queryKeys.asset(assetId));
  cache.invalidate(queryKeys.ledger(assetId));
  cache.invalidate(queryKeys.ipoPreviews(assetId));
  cache.invalidate(queryKeys.assets());
  cache.invalidate(queryKeys.reviewQueueAll());
}

export interface UploadDocument {
  file: File;
  docType: DocumentType;
}

/** Upload one document; the request body is the file itself (T69). Never retried. */
export function useUploadDocument(
  assetId: string,
): MutationResult<UploadDocument, ListingDocument> {
  return useApiMutation(
    (api, { file, docType }: UploadDocument) =>
      unwrap(
        api.POST("/assets/{asset_id}/documents", {
          params: {
            path: { asset_id: assetId },
            query: { doc_type: docType },
            header: { "content-type": file.type },
          },
          // The file goes as-is: the backend inspects its bytes.
          body: file as unknown as string,
          bodySerializer: (body: unknown) => body as BodyInit,
        }),
      ),
    {
      onSuccess: (_doc, _vars, { cache }) =>
        cache.invalidate(queryKeys.verificationDocuments(assetId)),
    },
  );
}

export interface SubmitVerification {
  /** New documents, never submitted before (1–3). */
  documentIds: string[];
}

/**
 * Submit uploaded documents for review: a new current run with its checklist. While the
 * current run waits for a decision, its documents stay in the new one (#210).
 */
export function useSubmitVerification(
  assetId: string,
): MutationResult<SubmitVerification, VerificationRun> {
  return useApiMutation(
    (api, { documentIds }: SubmitVerification) =>
      unwrap(
        api.POST("/assets/{asset_id}/verification/runs", {
          params: { path: { asset_id: assetId } },
          body: { document_ids: documentIds },
        }),
      ),
    {
      onSuccess: (_run, _vars, layer) =>
        afterVerificationChange(assetId, layer),
    },
  );
}

/** One page of listings waiting for a reviewer, oldest first (admins). */
export function useReviewQueue(
  offset: number,
  limit: number,
): QueryResult<ReviewQueueItem[]> {
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  return useApiQuery(
    queryKeys.reviewQueue(meId, offset),
    (api, signal) =>
      unwrap(
        api.GET("/admin/verifications", {
          params: { query: { limit, offset } },
          signal,
        }),
      ),
    { enabled: meId !== null },
  );
}

export type DecidedLevel = "verified" | "rejected" | "revoked";

/**
 * One page of listings whose current run was decided, latest decision first (admins, #211):
 * one level, or all three when `level` is null.
 */
export function useDecidedVerifications(
  level: DecidedLevel | null,
  offset: number,
  limit: number,
): QueryResult<DecidedListingItem[]> {
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  return useApiQuery(
    queryKeys.decidedVerifications(meId, level ?? "all", offset),
    (api, signal) =>
      unwrap(
        api.GET("/admin/verifications/decided", {
          params: { query: { limit, offset, ...(level ? { level } : {}) } },
          signal,
        }),
      ),
    { enabled: meId !== null },
  );
}

/**
 * One listing's review-queue item (admins): its current undecided run with the AI document
 * check's status and untrusted suggestion (T71). `null` when the listing isn't waiting in this
 * admin's queue. Asks again every `AI_POLL_MS` while it's enabled, the check is pending and the
 * tab is visible.
 */
export function useReviewQueueItem(
  assetId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): QueryResult<ReviewQueueItem | null> {
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  const query = useApiQuery(
    queryKeys.reviewQueueItem(meId, assetId ?? ""),
    async (api, signal) => {
      const items = await unwrap(
        api.GET("/admin/verifications", {
          params: { query: { asset_id: assetId ?? "", limit: 1 } },
          signal,
        }),
      );
      return items[0] ?? null;
    },
    { enabled: enabled && meId !== null && Boolean(assetId) },
  );
  // A decided run leaves the queue, but the cache may still say pending: only poll when enabled.
  const pending = enabled && query.data?.ai_suggestion_status === "pending";
  const { refetch } = query;
  useEffect(() => {
    if (!pending) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => void refetch(), AI_POLL_MS);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    // A hidden tab doesn't poll; it asks once when it's seen again.
    const onVisibility = () => {
      if (document.hidden) return stop();
      void refetch();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pending, refetch]);
  return query;
}

/**
 * Read a listing's verification and the queue again, e.g. after a decision was refused because
 * another reviewer or a newer submission got there first.
 */
export function useRefreshVerification(assetId: string): () => void {
  const { cache } = useDataLayer();
  return useCallback(() => {
    cache.invalidate(queryKeys.verification(assetId));
    cache.invalidate(queryKeys.reviewQueueAll());
  }, [cache, assetId]);
}

/** Refusals that mean the run on screen is out of date: reload it. */
export const STALE_DECISION_CODES: ReadonlySet<string> = new Set([
  "run_superseded",
  "run_already_decided",
  "stale_run",
]);

export type Decision = "approve" | "reject" | "revoke";

export interface DecideVerification {
  decision: Decision;
  runId: string;
  /** Required to reject or revoke; optional to approve. */
  reason: string;
}

/** Approve, reject or revoke a listing's run, with a reason (admins). Never retried. */
export function useDecideVerification(
  assetId: string,
): MutationResult<DecideVerification, VerificationRun> {
  return useApiMutation(
    (api, { decision, runId, reason }: DecideVerification) => {
      const params = { path: { asset_id: assetId, run_id: runId } };
      const text = reason.trim();
      switch (decision) {
        case "approve":
          return unwrap(
            api.POST("/admin/assets/{asset_id}/verification/{run_id}/approve", {
              params,
              body: { reason: text || null },
            }),
          );
        case "reject":
          return unwrap(
            api.POST("/admin/assets/{asset_id}/verification/{run_id}/reject", {
              params,
              body: { reason: text },
            }),
          );
        case "revoke":
          return unwrap(
            api.POST("/admin/assets/{asset_id}/verification/{run_id}/revoke", {
              params,
              body: { reason: text },
            }),
          );
      }
    },
    {
      onSuccess: (_run, _vars, layer) =>
        afterVerificationChange(assetId, layer),
    },
  );
}
