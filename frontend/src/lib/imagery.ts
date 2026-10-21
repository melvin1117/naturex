/** The satellite basemap behind every site map and boundary thumbnail, and its required credit. */
export const IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
/** Esri's required credit: "Powered by Esri" and the service's own source text. */
export const IMAGERY_ATTRIBUTION =
  "Powered by Esri · Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community";

export function imageryTileUrl(z: number, x: number, y: number): string {
  return IMAGERY_URL.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}
