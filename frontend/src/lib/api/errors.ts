/**
 * Typed API errors. Every failed request (HTTP error, network failure, failed world
 * bootstrap) surfaces as an `ApiError`, so screens only ever render `error.message`.
 */

/** FastAPI error bodies are `{ "detail": string }` or `{ "detail": ValidationError[] }`. */
type ValidationIssue = { loc?: unknown[]; msg?: string };

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

const CODE_MESSAGES: Record<string, string> = {
  auth_required: "Your sandbox has ended. Open a new one to keep going.",
  admin_only: "Only a platform admin can do that.",
  sandbox_only: "That only works in a demo sandbox.",
  csrf_origin:
    "Your browser sent this from an address WildWorth doesn't recognise. Open WildWorth from its usual address and try again.",
  demo_session_only: "Only a demo session can do that.",
  too_many_event_streams:
    "Live updates are busy right now; they will keep refreshing every few seconds.",
  copilot_rate_limited:
    "Bea has answered a lot of questions in this sandbox this hour. Try again later.",
  place_search_busy:
    "Lots of people are searching right now. Try again in a moment.",
  place_search_rate_limited:
    "You've searched a lot in the last minute. Wait a minute, or move the map yourself.",
  place_query_too_short: "Type a place name, such as a town or a lake.",
  place_search_unavailable:
    "Place search isn't available right now. Move the map yourself or type coordinates.",
  copilot_unavailable:
    "Bea can't search the Record right now. Try again in a little while.",
};

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    /** HTTP status, or 0 when the request never got a response (offline, DNS, CORS). */
    readonly status: number,
    message: string,
    /** Machine-readable code from a snake_case `detail` (e.g. `auth_required`), else null. */
    readonly code: string | null = null,
    /** The raw `detail` from the response body, for debugging and 422 field errors. */
    readonly detail: unknown = null,
    /** Seconds from the `Retry-After` header (429/503), else null. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

/** `Retry-After` is either delay-seconds or an HTTP date (RFC 9110 §10.2.3). */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** "a second", "45 seconds", "a minute", "14 minutes". */
export function formatWait(seconds: number): string {
  if (seconds < 60) return seconds <= 1 ? "a second" : `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

function isHumanText(detail: unknown): detail is string {
  return (
    typeof detail === "string" &&
    detail.length > 0 &&
    !CODE_PATTERN.test(detail)
  );
}

function validationMessage(detail: unknown): string {
  const first = Array.isArray(detail)
    ? (detail[0] as ValidationIssue | undefined)
    : undefined;
  if (!first?.msg) return "Some of the details you entered aren't valid.";
  const field = Array.isArray(first.loc)
    ? first.loc.filter((part) => part !== "body").join(".")
    : "";
  return field
    ? `Check ${field}: ${first.msg}.`
    : `Check your input: ${first.msg}.`;
}

function friendlyMessage(
  status: number,
  code: string | null,
  detail: unknown,
  retryAfter: number | null,
): string {
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  const wait = retryAfter === null ? "a moment" : formatWait(retryAfter);
  if (code === "too_many_attempts")
    return `Too many attempts. Try again in ${wait}.`;
  switch (status) {
    case 400:
      return isHumanText(detail)
        ? detail
        : "That request couldn't be processed.";
    case 401:
      // Login's generic "Email or password is incorrect" is human text; other 401s are codes.
      return isHumanText(detail)
        ? detail
        : "Your session has expired. Reload the page to continue.";
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return isHumanText(detail) ? detail : "We couldn't find that.";
    case 409:
      return isHumanText(detail)
        ? detail
        : "That clashes with a recent change. Refresh and try again.";
    case 422:
      return validationMessage(detail);
    case 429:
    case 503:
      if (isHumanText(detail)) return detail;
      return `WildWorth is busy right now. Try again in ${wait}.`;
    default:
      return status >= 500
        ? "Something went wrong on our side. Try again."
        : "The request failed. Try again.";
  }
}

/** Build an `ApiError` from a non-2xx response and its (already parsed) body. */
export function apiErrorFromResponse(
  response: Response,
  body: unknown,
): ApiError {
  const detail =
    body && typeof body === "object" && "detail" in body
      ? (body as { detail: unknown }).detail
      : (body ?? null);
  const code =
    typeof detail === "string" && CODE_PATTERN.test(detail) ? detail : null;
  const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
  return new ApiError(
    response.status,
    friendlyMessage(response.status, code, detail, retryAfter),
    code,
    detail,
    retryAfter,
  );
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

/** Normalise anything thrown (fetch TypeError, ApiError, unknown) into an `ApiError`. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(
    0,
    "Can't reach WildWorth. Check your connection and try again.",
    null,
    error instanceof Error ? error.message : error,
  );
}

type FetchResult<T> = { data?: T; error?: unknown; response: Response };

/**
 * Await an openapi-fetch call and return its data, or throw an `ApiError`.
 *
 * @example const asset = await unwrap(api.GET("/assets/{asset_id}", { params }));
 */
export async function unwrap<T>(request: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await request;
  } catch (error) {
    // Aborts stay AbortErrors so callers can tell "cancelled" from "failed".
    if (isAbortError(error)) throw error;
    throw toApiError(error);
  }
  const { data, error, response } = result;
  if (!response.ok) throw apiErrorFromResponse(response, error);
  return data as T;
}
