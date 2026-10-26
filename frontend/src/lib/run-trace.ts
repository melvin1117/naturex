/** Which real site a page is about, for Bea's starter questions. */
const ASSET_PATH =
  /^\/(?:asset|steward\/assets)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** The real asset a page is about (`/asset/<uuid>`, `/steward/assets/<uuid>/…`), or null. */
export function traceAssetFromPath(pathname: string | null): string | null {
  return (pathname && ASSET_PATH.exec(pathname)?.[1]) || null;
}
