/** The satellite basemap behind every site map and boundary thumbnail, and its required credit. */
export const IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const IMAGERY_ATTRIBUTION =
  "Imagery © Esri, Maxar, Earthstar Geographics";

export function imageryTileUrl(z: number, x: number, y: number): string {
  return IMAGERY_URL.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}
