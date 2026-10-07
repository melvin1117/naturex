import type { components } from "@/lib/api";

/** Sidecar metadata for a demo site's land-cover overlay and thumbnail (T35). */
export type SiteImages = components["schemas"]["SiteImages"];
export type LegendEntry = components["schemas"]["LegendEntry"];

export const DEMO_SITES = [
  { key: "wetland_mx", name: "Xochimilco Wetland" },
  { key: "mangrove_mx", name: "Ria Celestun Mangrove" },
  { key: "restoration_forest", name: "Sumidero Canyon Restoration Forest" },
] as const;

export type DemoSiteFile = "overlay.png" | "thumbnail.webp" | "images.json";

/** Same-origin URL through the `/api` proxy (next.config.ts); the backend serves the files. */
export function demoSiteMediaUrl(siteKey: string, file: DemoSiteFile): string {
  return `/api/media/demo-sites/${encodeURIComponent(siteKey)}/${file}`;
}
