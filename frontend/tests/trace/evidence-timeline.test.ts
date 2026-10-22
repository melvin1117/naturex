import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunTrace } from "@/lib/api/types";
import {
  type NewsItem,
  evidenceTimeline,
  mergeNews,
  signalPhrase,
  traceNews,
} from "@/lib/evidence-timeline";
import { runFollowUps, runSignals } from "@/lib/trace-view";

import investigatedJson from "./fixtures/run-celestun-investigated.json";
import recordedJson from "./fixtures/recorded-mangrove.json";

const run = investigatedJson as unknown as RunTrace;
const series: [string, number][] = Array.from({ length: 60 }, (_, i) => {
  const month = new Date(Date.UTC(2021, 9 + i, 1)).toISOString().slice(0, 7);
  return [month, 0.7 + (i % 12) / 100];
});

function news(overrides: Partial<NewsItem>): NewsItem {
  return {
    id: "n1",
    title: "A report",
    summary: null,
    date: "2026-07-14",
    at: "2026-10-22T00:00:00Z",
    direction: -1,
    severity: 3,
    kind: "encroachment",
    sourceLabel: "Found by News Scout",
    url: "https://example.com/a",
    ...overrides,
  };
}

describe("evidence timeline (a recorded investigated run)", () => {
  const signals = runSignals(run);
  const followUps = runFollowUps(run);
  const read = followUps.find((f) => f.kind === "read")!;
  const found = followUps.find((f) => f.kind === "search")!;
  const foundUrl = found.kind === "search" ? found.found[0]!.url! : "";

  it("bands code's dated signals a month either side, and pins news by month", () => {
    const t = evidenceTimeline(
      series,
      signals,
      [
        news({ id: "a", date: "2026-07-14" }),
        news({ id: "b", date: "2026-07-30", direction: 1 }),
        news({ id: "c", date: "2019-01-01" }),
      ],
      [],
    );
    expect(t.bands).toEqual([
      expect.objectContaining({
        id: "signal:greenness_2025_06",
        start: "2025-05",
        end: "2025-07",
        month: "2025-06",
        direction: -1,
      }),
    ]);
    expect(t.pins).toEqual([
      expect.objectContaining({ month: "2026-07", direction: -1 }),
    ]);
    expect(t.pins[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(t.entries.map((e) => `${e.type}:${e.month}`)).toEqual([
      "signal:2025-06",
      "news:2026-07",
      "news:2026-07",
    ]);
  });

  it("marks what Super's follow-ups found and read", () => {
    const t = evidenceTimeline(
      series,
      signals,
      [
        news({ id: "found", url: foundUrl, date: "2025-05-13", direction: 1 }),
        news({ id: "read", url: read.kind === "read" ? read.url : null }),
      ],
      followUps,
    );
    const byId = Object.fromEntries(
      t.entries.flatMap((e) => (e.type === "news" ? [[e.id, e]] : [])),
    );
    expect(byId.found).toMatchObject({ followUp: true, read: null });
    expect(byId.read).toMatchObject({
      followUp: false,
      read: { namesSite: true },
    });
    expect(t.followUps[0]).toBe(
      "Searched local news for drought in Apr–Aug 2025 to explain the June 2025 greenness change: 1 new item.",
    );
    expect(t.followUps[1]).toMatch(/^Read “.+”: names the site/);
  });

  it("is empty without a series, and words signals plainly", () => {
    expect(evidenceTimeline([], signals, [news({})], followUps)).toMatchObject({
      bands: [],
      pins: [],
      entries: [],
    });
    expect(signalPhrase("signal:greenness_last_12m")).toBe(
      "the latest 12 months' greenness",
    );
  });
});

describe("the news a recorded run found", () => {
  const trace = (recordedJson as unknown as { trace: RunTrace }).trace;

  it("comes from the audit's cited news and the follow-up searches, dated", () => {
    const items = traceNews(trace, "Recorded run, 22 Oct 2026");
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.sourceLabel))).toEqual(
      new Set(["Recorded run, 22 Oct 2026"]),
    );
    expect(items.every((i) => /^\d{4}-\d{2}-\d{2}/.test(i.date))).toBe(true);
    expect(items.every((i) => i.title.length > 0)).toBe(true);
  });

  it("merges without repeating a link the site already has", () => {
    const [first, ...rest] = traceNews(trace, "Recorded run");
    const merged = mergeNews([first!], [first!, ...rest, first!]);
    expect(merged).toHaveLength(
      1 + new Set(rest.map((r) => r.url ?? r.id)).size,
    );
  });
});

describe("the frontend's copy of a recording", () => {
  it("matches the committed backend file", () => {
    const backend = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          "../../../backend/data/demo_sites/recorded_runs/mangrove_mx.json",
        ),
        "utf-8",
      ),
    );
    expect(recordedJson).toEqual(backend);
  });
});
