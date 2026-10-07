import type { LegendEntry } from "@/lib/demo-site-images";

export function LandCoverLegend({
  entries,
}: {
  entries: readonly LegendEntry[];
}) {
  return (
    <ul
      aria-label="Land-cover legend"
      className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3"
    >
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-sm border"
            style={{ background: entry.color }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
