/**
 * Data hooks for field evidence (T40). Same contract as ./hooks.ts: queries give
 * `{ data, error, isLoading, refetch }`, mutations `{ mutate, mutateAsync, isPending, error }`.
 */
import { useEffect, useState } from "react";

import { unwrap } from "./api/errors";
import type {
  FieldEvidence,
  FieldEvidencePublic,
  FieldPhoto,
} from "./api/types";
import { queryKeys, type DataLayer } from "./data-layer";
import { EVIDENCE_POLL_MS, isPending } from "./field-evidence";
import {
  useApiMutation,
  useApiQuery,
  type MutationResult,
  type QueryResult,
} from "./hooks";

/**
 * A listing's photos and their checks (its community's members and same-world admins). Asks
 * again every `EVIDENCE_POLL_MS` while a photo is being read and the tab is visible.
 */
export function useFieldEvidence(
  assetId: string | undefined,
): QueryResult<FieldEvidence> {
  const query = useApiQuery(
    queryKeys.fieldEvidencePhotos(assetId ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/evidence", {
          params: { path: { asset_id: assetId ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(assetId) },
  );
  const pending = isPending(query.data);
  const { refetch } = query;
  useEffect(() => {
    if (!pending) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => void refetch(), EVIDENCE_POLL_MS);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
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

/** Field evidence in aggregate: anyone who can see the asset. */
export function useFieldEvidenceSummary(
  assetId: string | undefined,
): QueryResult<FieldEvidencePublic> {
  return useApiQuery(
    queryKeys.fieldEvidenceSummary(assetId ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/evidence/summary", {
          params: { path: { asset_id: assetId ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(assetId) },
  );
}

/** A photo as the API stores it (re-encoded, no metadata), as an object URL revoked on unmount. */
export function useFieldPhotoImage(
  assetId: string,
  photoId: string,
): { url: string | null; error: QueryResult<Blob>["error"] } {
  const query = useApiQuery(
    queryKeys.fieldPhotoImage(assetId, photoId),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/evidence/{photo_id}/image", {
          params: { path: { asset_id: assetId, photo_id: photoId } },
          parseAs: "blob",
          signal,
        }),
      ) as Promise<Blob>,
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
  return { url, error: query.error };
}

function afterEvidenceChange(assetId: string, { cache }: DataLayer) {
  cache.invalidate(queryKeys.fieldEvidence(assetId));
}

/** Upload one photo; the request body is the file itself, with its EXIF. Never retried. */
export function useUploadPhoto(
  assetId: string,
): MutationResult<File, FieldPhoto> {
  return useApiMutation(
    (api, file: File) =>
      unwrap(
        api.POST("/assets/{asset_id}/evidence", {
          params: {
            path: { asset_id: assetId },
            header: { "content-type": file.type },
          },
          // The file goes as-is: the backend reads its EXIF, then stores it without any.
          body: file as unknown as string,
          bodySerializer: (body: unknown) => body as BodyInit,
        }),
      ),
    {
      onSuccess: (_photo, _file, layer) => afterEvidenceChange(assetId, layer),
    },
  );
}

export function useDeletePhoto(
  assetId: string,
): MutationResult<string, unknown> {
  return useApiMutation(
    (api, photoId: string) =>
      unwrap(
        api.DELETE("/assets/{asset_id}/evidence/{photo_id}", {
          params: { path: { asset_id: assetId, photo_id: photoId } },
        }),
      ),
    {
      onSuccess: (_none, _id, layer) => afterEvidenceChange(assetId, layer),
    },
  );
}
