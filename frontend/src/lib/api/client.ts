/**
 * Typed API client. Regenerated types live in schema.d.ts — do not hand-edit that file.
 * Run: ./scripts/generate-client.sh
 */
import createClient from "openapi-fetch";

import type { paths } from "./schema";

/**
 * Browser code goes through the same-origin `/api` proxy (next.config.ts) so the
 * `nx_world` sandbox cookie is sent. Server code calls the backend directly and must
 * forward the visitor's `nx_world` cookie itself (T32).
 */
export function defaultBaseUrl(): string {
  return typeof window === "undefined"
    ? (process.env.BACKEND_URL ?? "http://localhost:8000")
    : "/api";
}

export function createApi(baseUrl = defaultBaseUrl()) {
  return createClient<paths>({ baseUrl, credentials: "same-origin" });
}

export const api = createApi();
