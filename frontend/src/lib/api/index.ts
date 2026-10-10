// Browser-safe entry point. Server code imports `createServerApi` from "@/lib/api/server".
export { api, createApi, type ApiClient } from "./client";
export { ApiError, toApiError, unwrap } from "./errors";
export type { paths, components } from "./schema";
export type * from "./types";
