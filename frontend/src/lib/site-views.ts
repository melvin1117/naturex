import type { AssetDetail } from "@/lib/api/types";
import { DEMO_SITES, demoSiteMediaUrl } from "@/lib/demo-site-images";

/** A site's two Sentinel-2 true-colour views five years apart, for the before/after slider. */
export interface BeforeAfterViews {
  before: string;
  after: string;
  /** The span they cover, for the credit line: "2021–2026". */
  years: string;
}

/** A demo site's precomputed pair, or a live listing's from its rating (`site_views`, served at
 * `/assets/{id}/views/{before,after}.webp`); null when it has neither. */
export function beforeAfterViews(
  asset: Pick<AssetDetail, "id" | "site_key" | "site_views">,
): BeforeAfterViews | null {
  const key = asset.site_key;
  if (key && DEMO_SITES.some((s) => s.key === key))
    return {
      before: demoSiteMediaUrl(key, "before.webp"),
      after: demoSiteMediaUrl(key, "thumbnail.webp"),
      years: "2021–2026",
    };
  const views = asset.site_views;
  if (!views) return null;
  const base = `/api/assets/${encodeURIComponent(asset.id)}/views`;
  const v = `?v=${encodeURIComponent(views.version)}`;
  return {
    before: `${base}/before.webp${v}`,
    after: `${base}/after.webp${v}`,
    years: `${views.before.start.slice(0, 4)}–${views.after.end.slice(0, 4)}`,
  };
}
