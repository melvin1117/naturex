/**
 * Typed API client. Regenerated types live in schema.d.ts — do not hand-edit that file.
 * Run: ./scripts/generate-client.sh
 */
import createClient from "openapi-fetch";

import type { paths } from "./schema";

export function createApi(baseUrl = "http://localhost:8000") {
  return createClient<paths>({ baseUrl });
}

export const api = createApi();
