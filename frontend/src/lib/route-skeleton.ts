/**
 * Which page-shaped skeleton a route shows while it loads (WP4, #216). The route's
 * `loading.tsx` and the layout gates (session, community) use the same shape, so a page
 * goes from skeleton to content without a spinner or a blank frame in between.
 */
export type SkeletonKind =
  | "asset"
  | "portfolio"
  | "steward-home"
  | "screen"
  | "review"
  | "time-machine"
  | "admin-list"
  | "page";

export function skeletonKind(pathname: string): SkeletonKind {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (/^\/asset\/[^/]+$/.test(path)) return "asset";
  if (path === "/portfolio") return "portfolio";
  if (path === "/steward") return "steward-home";
  if (/^\/steward\/assets\/[^/]+\/[^/]+$/.test(path)) return "screen";
  if (path === "/admin") return "time-machine";
  if (path === "/admin/verifications") return "admin-list";
  if (/^\/admin\/verifications\/[^/]+$/.test(path)) return "review";
  return "page";
}
