/**
 * Pure helpers for the `/judge` story (`components/story`): formatting the numbers `GET /story`
 * computed, the evidence of the hero wetland's recorded run, and the map geometry. No data is
 * invented here: every value comes from the API or the recorded run.
 */
import type { RecordedRun, Story, StoryRating } from "@/lib/api/types";
import { traceNews } from "@/lib/evidence-timeline";
import {
  auditCase,
  auditChecks,
  changeLabel,
  modelLabel,
  runVision,
  withoutCitations,
} from "@/lib/trace-view";

export const STORY_SITE = "wetland_mx";

export type LatLng = [number, number];

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `0.3574` → `36%`. */
export function share(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** `"21.4723"` → `$21.47`. */
export function dollars(value: string | number): string {
  return USD.format(Number(value));
}

/** The change from `from` to `to` in percent, signed with a true minus: `−4.0%`, `+8.8%`. */
export function change(from: string | number, to: string | number): string {
  const pct = ((Number(to) - Number(from)) / Number(from)) * 100;
  const text = Math.abs(pct).toFixed(1);
  return pct < 0 ? `−${text}%` : `+${text}%`;
}

/** `2121067, 2669511` → `$2.1–2.7M a year`. */
export function valueRange(low: number, high: number): string {
  const m = (v: number) => (v / 1_000_000).toFixed(1);
  return `$${m(low)}–${m(high)}M a year`;
}

/** `"76.2"` → `76.2`; health is shown with one decimal, as on the report card. */
export function health(value: string | number): string {
  return Number(value).toFixed(1);
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The ratings in story order: as it is, after the (simulated) damage, after the restoration. */
export function storyRatings(story: Story): {
  baseline: StoryRating;
  damaged: StoryRating;
  restored: StoryRating;
} {
  const by = (s: StoryRating["scenario"]) => {
    const found = story.ratings.find((r) => r.scenario === s);
    if (!found) throw new Error(`story has no ${s} rating`);
    return found;
  };
  return {
    baseline: by("baseline"),
    damaged: by("encroachment"),
    restored: by("restoration"),
  };
}

export type StoryEvidence = {
  recordedOn: string;
  planner: string | null;
  scout: string | null;
  vision: { model: string | null; reading: string } | null;
  auditor: { model: string | null; verdict: string } | null;
  citations: number | null;
  news: { title: string; host: string | null; url: string | null }[];
};

function stepModel(run: RecordedRun, name: string): string | null {
  const step = run.trace.steps.find((s) => s.step === name);
  return step?.model ? modelLabel(step.model) : null;
}

/** What each model did in the wetland's recorded run (a real run, committed as data). */
export function storyEvidence(run: RecordedRun): StoryEvidence {
  const trace = run.trace;
  const vision = runVision(trace);
  const audit = auditCase(trace);
  const checks = auditChecks(trace);
  const changes = vision?.changes.filter((c) => c.kind !== "no_clear_change");
  const seen = new Set<string>();
  const news = traceNews(trace, "Recorded run")
    .filter((n) => {
      const key = n.url ?? n.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(n.title);
    })
    .slice(0, 3)
    .map((n) => ({ title: n.title, host: hostOf(n.url), url: n.url ?? null }));
  return {
    recordedOn: run.recorded_on,
    planner: stepModel(run, "plan"),
    scout: stepModel(run, "news"),
    vision:
      vision && !vision.error
        ? {
            model: vision.model ? modelLabel(vision.model) : null,
            reading: changes?.length
              ? changes
                  .map((c) => `${changeLabel(c.kind)} (${c.where})`)
                  .join(", ")
              : "No clear change between the two views.",
          }
        : null,
    auditor:
      audit?.verdict != null
        ? {
            model: audit.model ? modelLabel(audit.model) : null,
            verdict: withoutCitations(audit.verdict),
          }
        : null,
    citations: checks ? checks.citations : null,
    news,
  };
}

/** The part of the boundary north of the line `share` of the way down from its top (an exact
 * half-plane clip of the ring): where the story's simulated damage lands. */
export function northEdge(ring: LatLng[], fraction = 0.22): LatLng[] {
  const lats = ring.map(([lat]) => lat);
  const top = Math.max(...lats);
  const cut = top - (top - Math.min(...lats)) * fraction;
  const out: LatLng[] = [];
  const open =
    ring[0]?.[0] === ring.at(-1)?.[0] && ring[0]?.[1] === ring.at(-1)?.[1];
  const pts = open ? ring.slice(0, -1) : ring;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    const pIn = p[0] >= cut;
    const qIn = q[0] >= cut;
    if (pIn) out.push(p);
    if (pIn !== qIn) {
      const t = (cut - p[0]) / (q[0] - p[0]);
      out.push([cut, p[1] + t * (q[1] - p[1])]);
    }
  });
  return out;
}

/** An SVG polyline for a 0–1 series, `width` × `height`, scaled to its own range. */
export function sparkline(
  values: number[],
  width: number,
  height: number,
): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - lo) / span) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** `"2021-10-01"` → `2021–22`: the first year of the five-year window. */
export function firstYearLabel(start: string): string {
  const year = Number(start.slice(0, 4));
  return `${year}–${String((year + 1) % 100).padStart(2, "0")}`;
}

/** The media URLs `GET /story` returns are under the API; the app reaches it at `/api`. */
export function apiMedia(path: string): string {
  return `/api${path}`;
}

/** Bounds as Leaflet takes them: `[[south, west], [north, east]]`. */
export function leafletBounds(b: {
  south: number;
  west: number;
  north: number;
  east: number;
}): [LatLng, LatLng] {
  return [
    [b.south, b.west],
    [b.north, b.east],
  ];
}
