import { describe, expect, it } from "vitest";

import type { RecordedRun, Story } from "@/lib/api/types";
import {
  change,
  dollars,
  firstYearLabel,
  hostOf,
  northEdge,
  share,
  sparkline,
  storyEvidence,
  storyRatings,
  valueRange,
  type LatLng,
} from "@/lib/story";

import recorded from "./recorded-wetland.json";
import storyJson from "./story.json";

const STORY = storyJson as unknown as Story;
const RUN = recorded as unknown as RecordedRun;

describe("story formatting", () => {
  it("shows the API's numbers, never new ones", () => {
    expect(share(0.3574)).toBe("36%");
    expect(dollars("21.4723")).toBe("$21.47");
    expect(dollars(2149.38)).toBe("$2,149.38");
    expect(valueRange(2121067, 2669511)).toBe("$2.1–2.7M a year");
    expect(change("21.4723", "20.6053")).toBe("−4.0%");
    expect(change("20.6053", "22.4163")).toBe("+8.8%");
    expect(firstYearLabel("2021-10-01")).toBe("2021–22");
    expect(hostOf("https://www.example.org/a")).toBe("example.org");
    expect(hostOf("not a url")).toBeNull();
  });

  it("puts the ratings in story order: as it is, damaged, restored", () => {
    const { baseline, damaged, restored } = storyRatings(STORY);
    expect([baseline.scenario, damaged.scenario, restored.scenario]).toEqual([
      "baseline",
      "encroachment",
      "restoration",
    ]);
    expect(baseline.simulated).toBe(false);
    expect(damaged.simulated && restored.simulated).toBe(true);
    expect(Number(damaged.health)).toBeLessThan(Number(baseline.health));
  });
});

describe("storyEvidence", () => {
  it("reads what each model did from the recorded run", () => {
    const evidence = storyEvidence(RUN);
    expect(evidence.recordedOn).toBe(RUN.recorded_on);
    expect(evidence.planner).toMatch(/Nemotron/);
    expect(evidence.vision?.model).toMatch(/Super VL/);
    expect(evidence.auditor?.model).toMatch(/Ultra/);
    // Citation tags are stripped for reading; the claim itself is the Auditor's.
    expect(evidence.auditor?.verdict).not.toMatch(/\[(signal|metric|event):/);
    expect(evidence.citations).toBeGreaterThan(0);
    expect(evidence.news.length).toBeGreaterThan(0);
    expect(evidence.news.length).toBeLessThanOrEqual(3);
    const urls = evidence.news.map((n) => n.url ?? n.title);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("map geometry", () => {
  it("clips the boundary to its northern band exactly", () => {
    const ring = STORY.site.boundary as LatLng[];
    const edge = northEdge(ring, 0.25);
    const lats = ring.map(([lat]) => lat);
    const top = Math.max(...lats);
    const cut = top - (top - Math.min(...lats)) * 0.25;
    expect(edge.length).toBeGreaterThanOrEqual(3);
    for (const [lat] of edge) expect(lat).toBeGreaterThanOrEqual(cut - 1e-12);
    expect(Math.max(...edge.map(([lat]) => lat))).toBe(top);
  });

  it("draws a series in its box", () => {
    const points = sparkline([0.4, 0.6, 0.5], 300, 40).split(" ");
    expect(points).toHaveLength(3);
    expect(points[0]).toBe("0.0,39.0");
    expect(points[1]).toBe("150.0,1.0");
    expect(sparkline([0.5], 300, 40)).toBe("");
  });
});
