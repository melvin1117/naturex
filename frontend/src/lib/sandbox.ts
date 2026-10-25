/**
 * The sandbox's URL space (`/sandbox/*`): a no-sign-up visitor's private sandbox runs the same
 * screens as the real app under this prefix, against the API's sandbox channel
 * (`/api/sandbox/*`, cookie `ww_demo`). Screens keep writing app paths (`/asset/…`); links and
 * the router add the prefix inside the sandbox (`@/lib/nav`, `@/components/app-link`).
 */

export const SANDBOX_BASE = "/sandbox";
export const SANDBOX_API_BASE = "/api/sandbox";

/** First path segments the sandbox mirrors; anything else (`/judge`, `/login`) stays as is. */
const MIRRORED = new Set([
  "",
  "asset",
  "portfolio",
  "ai",
  "trace",
  "admin",
  "steward",
]);

export function isSandboxPath(pathname: string | null | undefined): boolean {
  return (
    pathname === SANDBOX_BASE ||
    (pathname?.startsWith(`${SANDBOX_BASE}/`) ?? false)
  );
}

/** An app path as the sandbox serves it (`/asset/1` → `/sandbox/asset/1`). */
export function sandboxHref(href: string): string {
  if (!href.startsWith("/") || href.startsWith("//") || isSandboxPath(href))
    return href;
  const path = href.split(/[?#]/, 1)[0]!;
  const first = path.split("/")[1] ?? "";
  if (!MIRRORED.has(first)) return href;
  return path === "/"
    ? `${SANDBOX_BASE}${href.slice(1)}`
    : `${SANDBOX_BASE}${href}`;
}

/** The app path a sandbox URL shows (`/sandbox/asset/1` → `/asset/1`). */
export function appPath(pathname: string): string {
  if (!isSandboxPath(pathname)) return pathname;
  return pathname.slice(SANDBOX_BASE.length) || "/";
}
