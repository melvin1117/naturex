/**
 * Sign-in helpers (T61, ADR-0005 §1): safe return paths, the protected-route rule, form
 * validation and the messages for every auth failure. Pure, so they're unit tested; the React
 * side is `useAuth()` in ./hooks.ts and `<RequireAccount>` in components/require-account.tsx.
 *
 * The session is the HttpOnly `nx_session` cookie only: nothing here reads or stores a token.
 */
import { formatWait, type ApiError } from "./api/errors";
import type { components } from "./api/schema";

export type Me = components["schemas"]["MeOut"];

/** Mirrors backend/app/auth.py; the backend still validates (422). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 80;
export const EMAIL_MAX_LENGTH = 254;

export const LOGIN_PATH = "/login";
export const REGISTER_PATH = "/register";

const MAX_RETURN_PATH = 2048;
// Any base works: it only tells a same-origin path apart from one that leaves the site.
const PROBE_ORIGIN = "https://naturex.invalid";

function startsLikeAnotherHost(path: string): boolean {
  return path.startsWith("//") || path.startsWith("/\\");
}

/**
 * Where to go after sign-in: `raw` if it's a same-origin relative path, else `fallback`.
 *
 * Rejects absolute URLs (`https://…`, `javascript:`), protocol-relative ones (`//evil.com`,
 * `/\evil.com`, which browsers treat as `//`), also once dot segments are resolved or the path
 * is decoded (`/.//evil.com`, `/%2e%2e//evil.com`, `/%2F%2Fevil.com`), backslashes, whitespace
 * and control characters anywhere, and the sign-in pages themselves (no loop).
 */
export function safeReturnPath(
  raw: string | null | undefined,
  fallback = "/",
): string {
  if (!raw || raw.length > MAX_RETURN_PATH) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  // Backslashes, whitespace and control characters: browsers strip or rewrite them
  // (`/\t/evil.com` becomes `//evil.com`), so no legitimate path here contains them.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  // Dot segments normalise into a protocol-relative path: `/.//evil.com`, `/a/..//evil.com`
  // and `/%2e%2e//evil.com` all become `//evil.com`. Check what we'd actually return, and its
  // decoded form too (`/%2F%2Fevil.com`, `/%5Cevil.com`).
  if (startsLikeAnotherHost(url.pathname)) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return fallback;
  }
  if (startsLikeAnotherHost(decoded)) return fallback;
  if (url.pathname === LOGIN_PATH || url.pathname === REGISTER_PATH)
    return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `base?next=<path>`, or plain `base` when there's nowhere useful to come back to. */
export function withNext(base: string, next?: string | null): string {
  const path = safeReturnPath(next, "");
  return path && path !== "/"
    ? `${base}?next=${encodeURIComponent(path)}`
    : base;
}

/** `/login?next=<path>`: where a protected page or "Sign in" sends the visitor. */
export function loginHref(next?: string | null): string {
  return withNext(LOGIN_PATH, next);
}

export type Access =
  "checking" | "allowed" | "sign-in" | "forbidden" | "unavailable";

/**
 * Who may see a protected route. A signed-in account may (an admin route needs `is_admin`,
 * else 403); anonymous visitors go to sign-in. `prototypeDemo` (only on routes that opt in,
 * never `/admin`) lets the scripted prototype demo (persona switcher, judge landing, tour) keep
 * working for anonymous visitors until T65 replaces it with real demo sessions, whose persona
 * will be `me`. Either way the backend
 * checks every request; this decides only what the page shows.
 */
export function protectedAccess({
  status,
  me,
  admin = false,
  prototypeDemo,
  prototypeReady,
}: {
  status: "idle" | "loading" | "ready" | "error";
  me: Me | null | undefined;
  admin?: boolean;
  prototypeDemo: boolean;
  prototypeReady: boolean;
}): Access {
  if (me) return admin && !me.is_admin ? "forbidden" : "allowed";
  if (!prototypeReady) return "checking";
  if (prototypeDemo) return "allowed";
  if (status === "ready") return "sign-in";
  if (status === "error") return "unavailable";
  return "checking";
}

export type AuthMode = "login" | "register";
export type AuthField = "name" | "email" | "password";
export type FieldErrors = Partial<Record<AuthField, string>>;

export interface AuthInput {
  name?: string;
  email: string;
  password: string;
}

/** Length as the backend counts it (Python `len`: code points, not UTF-16 units). */
export function codePoints(value: string): number {
  return [...value].length;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PASSWORD_RULE = `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`;

const MESSAGES = {
  nameMissing: "Enter a display name.",
  nameTooLong: `Use ${NAME_MAX_LENGTH} characters or fewer for your display name.`,
  emailMissing: "Enter your email address.",
  emailInvalid: "Enter a valid email address, like name@example.org.",
  passwordMissing: "Enter your password.",
  passwordTooShort: `Use at least ${PASSWORD_MIN_LENGTH} characters for your password.`,
  passwordTooLong: `Use ${PASSWORD_MAX_LENGTH} characters or fewer for your password.`,
} as const;

/** Checks before sending, mirroring the backend rules. Empty object = valid. */
export function validateAuthInput(
  mode: AuthMode,
  input: AuthInput,
): FieldErrors {
  const errors: FieldErrors = {};
  if (mode === "register") {
    const name = (input.name ?? "").trim();
    if (!name) errors.name = MESSAGES.nameMissing;
    else if (codePoints(name) > NAME_MAX_LENGTH)
      errors.name = MESSAGES.nameTooLong;
  }
  const email = input.email.trim();
  if (!email) errors.email = MESSAGES.emailMissing;
  else if (codePoints(email) > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email))
    errors.email = MESSAGES.emailInvalid;
  if (!input.password) errors.password = MESSAGES.passwordMissing;
  else if (codePoints(input.password) > PASSWORD_MAX_LENGTH)
    errors.password = MESSAGES.passwordTooLong;
  else if (
    mode === "register" &&
    codePoints(input.password) < PASSWORD_MIN_LENGTH
  )
    errors.password = MESSAGES.passwordTooShort;
  return errors;
}

export interface AuthFailure {
  /** Shown above the submit button; null when the problem is a single field. */
  form: string | null;
  fields: FieldErrors;
}

function fieldMessage(field: AuthField, type: string | undefined): string {
  if (field === "password") {
    if (type === "string_too_long") return MESSAGES.passwordTooLong;
    if (type === "missing") return MESSAGES.passwordMissing;
    return MESSAGES.passwordTooShort;
  }
  if (field === "name") {
    return type === "string_too_long"
      ? MESSAGES.nameTooLong
      : MESSAGES.nameMissing;
  }
  return MESSAGES.emailInvalid;
}

function validationFailure(detail: unknown): AuthFailure {
  const fields: FieldErrors = {};
  if (Array.isArray(detail)) {
    for (const issue of detail as { loc?: unknown[]; type?: string }[]) {
      const field = issue?.loc?.at(-1);
      if (field === "name" || field === "email" || field === "password") {
        fields[field] ??= fieldMessage(field, issue.type);
      }
    }
  }
  return Object.keys(fields).length
    ? { form: null, fields }
    : { form: "Some of the details you entered aren't valid.", fields };
}

function waitText(seconds: number | null): string {
  return seconds === null ? "a few minutes" : formatWait(seconds);
}

/**
 * What the form says for a failed sign-in or sign-up. Login failures stay generic: the
 * backend returns the same 401 for an unknown email and a wrong password, and so do we.
 */
export function authFailure(mode: AuthMode, error: ApiError): AuthFailure {
  const form = (message: string): AuthFailure => ({
    form: message,
    fields: {},
  });
  if (error.isNetworkError)
    return form("Can't reach NatureX. Check your connection and try again.");
  switch (error.status) {
    case 401:
      return form("Email or password is incorrect.");
    case 409:
      return mode === "register"
        ? {
            form: null,
            fields: {
              email:
                "This email can't be used to create an account. If it's yours, sign in instead.",
            },
          }
        : form(error.message);
    case 422:
      return validationFailure(error.detail);
    case 429:
      return form(
        `Too many attempts. For your security, wait ${waitText(error.retryAfterSeconds)} and try again.`,
      );
    case 403:
      return form(error.message);
    case 503:
      return form(
        `NatureX is busy right now. Try again in ${waitText(error.retryAfterSeconds)}.`,
      );
    default:
      return form(
        error.status >= 500
          ? "Something went wrong on our side. Try again."
          : error.message,
      );
  }
}

/** Initials for the account button: "Rosa Díaz" → "RD", "rosa" → "R". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : parts;
  return letters
    .map((part) => Array.from(part ?? "")[0] ?? "")
    .join("")
    .toUpperCase();
}
