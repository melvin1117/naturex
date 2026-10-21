/**
 * Which page-shaped skeleton a route shows while it loads (WP4, #216). The route's
 * `loading.tsx` and the layout gates (session, community) draw the same shape, and its
 * `data-skeleton` is this name, so a page goes from skeleton to content without a spinner or
 * a blank frame in between. A test checks every `loading.tsx` against this map.
 */
export type SkeletonKind =
  | "asset"
  | "portfolio"
  | "steward-home"
  | "community-settings"
  | "screen"
  | "ipo"
  | "review"
  | "time-machine"
  | "queue"
  | "page";

export function skeletonKind(pathname: string): SkeletonKind {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (/^\/asset\/[^/]+$/.test(path)) return "asset";
  if (path === "/portfolio") return "portfolio";
  if (path === "/steward") return "steward-home";
  if (path === "/steward/community") return "community-settings";
  if (/^\/steward\/assets\/[^/]+\/ipo$/.test(path)) return "ipo";
  if (/^\/steward\/assets\/[^/]+\/[^/]+$/.test(path)) return "screen";
  if (path === "/admin") return "time-machine";
  if (path === "/admin/verifications") return "queue";
  if (/^\/admin\/verifications\/[^/]+$/.test(path)) return "review";
  return "page";
}
