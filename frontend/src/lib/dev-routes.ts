/**
 * Whether `/dev/*` harness pages (e.g. `/dev/trade`) are served: always in development and
 * tests, and in a production build only with `NATUREX_DEV_ROUTES=true` (read at request time).
 */
export function devRoutesEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV !== "production" || env.NATUREX_DEV_ROUTES === "true";
}
