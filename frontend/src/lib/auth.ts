import type { components } from "./api/schema";

export type Me = components["schemas"]["MeOut"];

export const LOGIN_PATH = "/login";
export const REGISTER_PATH = "/register";

const MAX_RETURN_PATH = 2048;
// Any base works: it only tells a same-origin path apart from one that leaves the site.
const PROBE_ORIGIN = "https://wildworth.invalid";

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
export type AuthField = "name" | "email" | "password";
export type FieldErrors = Partial<Record<AuthField, string>>;

/** Initials for the account button: "Rosa Díaz" → "RD", "rosa" → "R". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : parts;
  return letters
    .map((part) => Array.from(part ?? "")[0] ?? "")
    .join("")
    .toUpperCase();
}
