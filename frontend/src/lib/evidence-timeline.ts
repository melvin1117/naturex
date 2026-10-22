/**
 * The evidence timeline (asset Overview): five years of greenness with what the rating run
 * found on it. Code's dated signals become bands, dated news becomes pins, and the run's
 * follow-ups (Super's searches and read articles) are matched back onto the news.
 *
 * Pure, so it is easy to test; every value comes from the API.
 */
import type { newsItems } from "./asset-detail";
import {
  type FollowUp,
  type Signal,
  citationLabel,
  monthRange,
  readVerdict,
  topicLabel,
} from "./trace-view";

export type NewsItem = ReturnType<typeof newsItems>[number];

export type TimelineBand = {
  id: string;
  /** Chart span: a month either side of the signal's own months. */
  start: string;
  end: string;
  /** The signal's first month. */
  month: string;
  direction: number;
  label: string;
  text: string;
};

export type TimelineRead = { namesSite: boolean; verdict: string };

export type TimelineNews = {
  id: string;
  month: string;
  date: string;
  title: string;
  url: string | null;
  direction: number;
  kind: string | null;
  source: string;
  read: TimelineRead | null;
  /** Found by one of Super's follow-up searches, not the first search. */
  followUp: boolean;
};

export type TimelinePin = {
  month: string;
  direction: number;
  items: TimelineNews[];
};

export type TimelineEntry =
  ({ type: "signal" } & TimelineBand) | ({ type: "news" } & TimelineNews);

export type EvidenceTimeline = {
  bands: TimelineBand[];
  pins: TimelinePin[];
  entries: TimelineEntry[];
  /** One plain sentence per follow-up Super ran. */
  followUps: string[];
};

const MONTH_RE = /^\d{4}-\d{2}$/;
const MONTH_NAMES =
  "January February March April May June July August September October November December".split(
    " ",
  );

/** "the June 2025 greenness change", for a sentence about a signal. */
export function signalPhrase(id: string): string {
  const anomaly = /^signal:greenness_(\d{4})_(\d{2})$/.exec(id);
  if (anomaly)
    return `the ${MONTH_NAMES[Number(anomaly[2]) - 1]} ${anomaly[1]} greenness change`;
  if (id === "signal:greenness_last_12m")
    return "the latest 12 months' greenness";
  return citationLabel(id).toLowerCase();
}

function pinDirection(items: TimelineNews[]): number {
  if (items.some((i) => i.direction < 0)) return -1;
  if (items.some((i) => i.direction > 0)) return 1;
  return 0;
}

export function evidenceTimeline(
  series: [string, number][],
  signals: Signal[],
  news: NewsItem[],
  followUps: FollowUp[],
): EvidenceTimeline {
  const months = series
    .map(([m]) => m.slice(0, 7))
    .filter((m) => MONTH_RE.test(m));
  const first = months[0];
  const last = months.at(-1);
  const inRange = (m: string) =>
    Boolean(first && last && m >= first && m <= last);

  // A band spans from the month before its start to the month after its end, so even a
  // one-month change has width on the chart's month axis.
  const at = (m: string) => months.indexOf(m);
  const bands = signals
    .filter((s) => s.kind === "greenness_anomaly" && inRange(s.start))
    .map((s) => {
      const end = last && s.end > last ? last : s.end;
      return {
        id: s.id,
        start: months[Math.max(0, at(s.start) - 1)] ?? s.start,
        end: months[Math.min(months.length - 1, at(end) + 1)] ?? end,
        month: s.start,
        direction: s.direction,
        label: citationLabel(s.id),
        text: s.text,
      };
    });

  const reads = new Map<string, TimelineRead>();
  const found = new Set<string>();
  for (const f of followUps) {
    if (f.kind === "read" && f.status === "ok" && f.url)
      reads.set(f.url, { namesSite: f.namesSite, verdict: readVerdict(f) });
    if (f.kind === "search")
      for (const item of f.found) if (item.url) found.add(item.url);
  }

  const dated: TimelineNews[] = news
    .filter(
      (n) => MONTH_RE.test(n.date.slice(0, 7)) && inRange(n.date.slice(0, 7)),
    )
    .map((n) => ({
      id: n.id,
      month: n.date.slice(0, 7),
      date: n.date.slice(0, 10),
      title: n.title,
      url: n.url,
      direction: n.direction ?? 0,
      kind: n.kind,
      source: n.sourceLabel,
      read: (n.url && reads.get(n.url)) || null,
      followUp: Boolean(n.url && found.has(n.url)),
    }));

  const byMonth = new Map<string, TimelineNews[]>();
  for (const n of dated)
    byMonth.set(n.month, [...(byMonth.get(n.month) ?? []), n]);
  const pins = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, items]) => ({
      month,
      items,
      direction: pinDirection(items),
    }));

  const entries: TimelineEntry[] = [
    ...bands.map((b) => ({ type: "signal" as const, ...b })),
    ...dated.map((n) => ({ type: "news" as const, ...n })),
  ].sort((a, b) => a.month.localeCompare(b.month));

  const notes = followUps.map((f) =>
    f.kind === "search"
      ? `Searched local news for ${topicLabel(f.topic)}${f.window ? ` in ${monthRange(f.window.start, f.window.end)}` : ""} to explain ${signalPhrase(f.signal)}: ${f.status === "ok" ? `${f.found.length} new item${f.found.length === 1 ? "" : "s"}` : "the search failed"}.`
      : `Read “${f.title ?? "an article"}”: ${f.status === "ok" ? readVerdict(f) : "it couldn't be read"}.`,
  );

  return { bands, pins, entries, followUps: notes };
}
