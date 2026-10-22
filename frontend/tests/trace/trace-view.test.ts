import { describe, expect, it } from "vitest";

import type { RunTrace } from "@/lib/api/types";
import {
  auditCase,
  auditChecks,
  caseEvidence,
  changeLabel,
  citationLabel,
  costReceipt,
  modelLabel,
  monthRange,
  newsFunnel,
  runFlow,
  runFollowUps,
  runPlan,
  runSearches,
  runSignals,
  runStory,
  runTimeline,
  runVision,
  topicLabel,
  withoutCitations,
} from "@/lib/trace-view";

import celestunJson from "./fixtures/run-celestun.json";
import sumideroJson from "./fixtures/run-sumidero.json";
import visionJson from "./fixtures/run-xochimilco-vision.json";
import investigatedJson from "./fixtures/run-celestun-investigated.json";

// Real runs recorded on Oct 22, 2026 (live Token Factory and Tavily, demo sites).
const celestun = celestunJson as unknown as RunTrace;
const sumidero = sumideroJson as unknown as RunTrace;

describe("runStory", () => {
  it("tells who did what, in order, with the run's own numbers", () => {
    const story = runStory(celestun);

    expect(story.map((l) => l.key)).toEqual([
      "plan",
      "earth",
      "value",
      "news",
      "audit",
      "checks",
      "seal",
    ]);
    expect(story.map((l) => l.actor)).toEqual([
      "super",
      "code",
      "code",
      "tavily",
      "ultra",
      "code",
      "ledger",
    ]);
    const news = story.find((l) => l.key === "news")!;
    expect(news.text).toMatch(/^Tavily ran 4 web searches \(1 in Spanish\)/);
    expect(news.text).toContain("Nemotron 3 Nano read 8");
    expect(news.details).toHaveLength(4);
    const audit = story.find((l) => l.key === "audit")!;
    expect(audit.text).toMatch(
      /^Nemotron 3 Ultra thought it through \(1,938 reasoning tokens\)/,
    );
    expect(audit.text).not.toMatch(/\[(event|signal|metric):/);
    expect(story.at(-1)!.text).toMatch(/less than running every call on Ultra/);
  });
});

describe("runFlow", () => {
  it("puts the tools on a spine with Super's choices and their branches", () => {
    const flow = runFlow(celestun);

    expect(flow.map((n) => n.step)).toEqual([
      "earth_obs",
      "valuation",
      "news",
      "evidence",
      "audit",
      "done",
    ]);
    expect(flow[0]!.decision?.text).toBe("Nemotron 3 Super called earth_obs");
    const news = flow.find((n) => n.step === "news")!;
    expect(news.actor).toBe("tavily");
    expect(news.children.map((c) => c.actor)).toEqual([
      "tavily",
      "tavily",
      "tavily",
      "tavily",
      "nano",
      "code",
    ]);
    expect(news.children[3]!.title).toBe("Search (Spanish)");
    const audit = flow.find((n) => n.step === "audit")!;
    expect(audit.actor).toBe("ultra");
    expect(audit.children[0]!.title).toBe("Think and judge");
    expect(audit.children.at(-1)!.title).toBe("Claim check");
    expect(flow.find((n) => n.step === "evidence")!.status).toBe("skipped");
  });
});

describe("runTimeline", () => {
  it("places every call on one axis, with the searches side by side", () => {
    const { totalMs, lanes } = runTimeline(celestun);

    expect(lanes.map((l) => l.actor)).toEqual([
      "super",
      "code",
      "tavily",
      "nano",
      "ultra",
    ]);
    const tavily = lanes.find((l) => l.actor === "tavily")!.bars;
    expect(tavily).toHaveLength(4);
    expect(new Set(tavily.map((b) => b.startMs)).size).toBe(1);
    const ultra = lanes.find((l) => l.actor === "ultra")!.bars[0]!;
    expect(ultra.label).toBe("think and judge");
    for (const lane of lanes)
      for (const bar of lane.bars) {
        expect(bar.startMs).toBeGreaterThanOrEqual(0);
        expect(bar.endMs).toBeGreaterThan(bar.startMs);
        expect(bar.endMs).toBeLessThanOrEqual(totalMs + 1);
      }
  });
});

describe("auditCase", () => {
  it("resolves each cited ID to the fact or news item behind it", () => {
    const c = auditCase(celestun)!;

    expect(c.source).toBe("ultra");
    expect(modelLabel(c.model)).toBe("Nemotron 3 Ultra");
    expect(c.hypotheses.map((h) => h.assessment)).toEqual([
      "supported",
      "weakened",
      "unclear",
    ]);
    expect(c.adjustment).toBe(-2);
    expect(c.health).toBe(c.baseHealth! - 2);
    const refs = caseEvidence(c);
    const news = refs.find((r) => r.kind === "news")!;
    expect(news.url).toMatch(/^https:\/\//);
    expect(news.label.length).toBeGreaterThan(5);
    expect(refs.some((r) => r.kind === "fact" && r.value)).toBe(true);
    expect(c.reasoningTokens).toBe(1938);
    expect(c.notes).toBeTruthy();
  });

  it("is absent without an audit and labels IDs for people", () => {
    expect(auditCase({ ...celestun, steps: [] })).toBeNull();
    expect(citationLabel("signal:greenness_2025_06")).toBe(
      "Greenness, Jun 2025",
    );
    expect(citationLabel("metric:landcover.flooded_vegetation")).toBe(
      "Land cover: flooded vegetation",
    );
    expect(
      withoutCitations("Clearing [event:abc, metric:x] continues [signal:y]."),
    ).toBe("Clearing continues.");
  });
});

describe("checks and cost", () => {
  it("shows the news funnel and the claim checks", () => {
    const funnel = newsFunnel(celestun)!;
    expect(funnel.map((s) => s.count)).toEqual([20, 18, 18, 8, 4, 4]);
    expect(auditChecks(celestun)).toMatchObject({ refused: 0, rounds: 1 });
    expect(runSearches(sumidero).every((s) => s.credits === 2)).toBe(true);
    expect(runSignals(sumidero).length).toBeGreaterThan(0);
  });

  it("prices the routing against Ultra alone", () => {
    const r = costReceipt(celestun);

    expect(r.models.map((m) => m.actor)).toEqual(["ultra", "super", "nano"]);
    expect(r.models.reduce((n, m) => n + m.share, 0)).toBeCloseTo(1, 5);
    expect(r.baselineUsd).toBeGreaterThan(r.totalUsd);
    expect(r.savedPct).toBeGreaterThan(0);
    expect(r.credits).toBe(8);
  });
});

describe("vision (a run with Nemotron 3.5 Super VL, Oct 22)", () => {
  const vision = visionJson as unknown as RunTrace;

  it("reads the before/after comparison from the satellite step", () => {
    const v = runVision(vision)!;
    expect(v.model).toMatch(/Nemotron-3\.5-Super-VL/);
    expect(v.before?.water).toBeTruthy();
    expect(v.changes[0]!.id).toBe("image:1");
    expect(runVision(celestun)).toBeNull();
  });

  it("puts it in the story, the flow and the timeline", () => {
    const story = runStory(vision);
    expect(story.map((l) => l.key)).toContain("vision");
    expect(story.find((l) => l.key === "vision")!.actor).toBe("vision");
    const earth = runFlow(vision).find((n) => n.step === "earth_obs")!;
    expect(earth.children[0]).toMatchObject({ id: "vision", actor: "vision" });
    expect(earth.children[0]!.title).toBe("Compare the images");
    const lanes = runTimeline(vision).lanes.map((l) => l.actor);
    expect(lanes).toContain("vision");
    expect(changeLabel("vegetation_loss")).toBe("less vegetation");
  });
});

describe("investigation (Super plans and follows up, Oct 22)", () => {
  const run = investigatedJson as unknown as RunTrace;

  it("reads Super's plan and its two follow-ups", () => {
    const plan = runPlan(run)!;
    expect(plan.chose).toEqual(["search_news"]);
    expect(plan.reasoningTokens).toBeGreaterThan(0);
    expect(plan.notes).toMatch(/greenness/);
    expect(plan.costUsd).toBeGreaterThan(0);

    const [search, read] = runFollowUps(run);
    expect(search).toMatchObject({
      kind: "search",
      topic: "drought",
      signal: "signal:greenness_2025_06",
    });
    expect(search!.kind === "search" && search!.searches[0]!.language).toBe(
      "es",
    );
    expect(read).toMatchObject({
      kind: "read",
      namesSite: true,
      quoteChecked: true,
    });
    expect(read!.why).toMatch(/encroachment/);
    expect(runPlan(celestun)).toBeNull();
    expect(runFollowUps(celestun)).toEqual([]);
  });

  it("tells it in the story and counts it in the receipt", () => {
    const line = runStory(run).find((l) => l.key === "followup")!;
    expect(line.actor).toBe("super");
    expect(line.text).toMatch(
      /followed up: searched local news for drought in Apr–Aug 2025 \(1 new\); had an article read \(names the site/,
    );
    expect(line.details).toHaveLength(2);
    const receipt = costReceipt(run);
    expect(receipt.searches).toBe(5);
    expect(receipt.reads).toBe(1);
    expect(receipt.credits).toBeCloseTo(10.2);
    expect(costReceipt(celestun).reads).toBe(0);
  });

  it("puts the plan and each follow-up on the flow and the timeline", () => {
    const flow = runFlow(run);
    const ids = flow.map((n) => n.id);
    expect(ids).toEqual([
      "earth_obs",
      "valuation",
      "news",
      "plan",
      "investigate-0",
      "investigate-1",
      "evidence",
      "audit",
      "done",
    ]);
    const plan = flow.find((n) => n.id === "plan")!;
    expect(plan).toMatchObject({ actor: "super", decision: null });
    expect(plan.costUsd).toBeGreaterThan(0);
    const search = flow.find((n) => n.id === "investigate-0")!;
    expect(search.title).toBe("Search again: drought");
    expect(search.decision?.text).toBe("Nemotron 3 Super chose it in its plan");
    expect(search.children.map((c) => c.id)).toEqual([
      "investigate-0-search-0",
      "investigate-0-classify-0",
    ]);
    const read = flow.find((n) => n.id === "investigate-1")!;
    expect(read.decision?.text).toBe("Nemotron 3 Super called read_article");
    expect(read.children.map((c) => c.title)).toEqual([
      "Open the page",
      "Answer the question",
      "Check the answer",
    ]);
    const labels = runTimeline(run).lanes.flatMap((l) =>
      l.bars.map((b) => b.label),
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        "plan (thinking)",
        "search: drought",
        "open the page",
        "read the article",
      ]),
    );
  });

  it("words the helpers plainly", () => {
    expect(monthRange("2024-11-01", "2025-03-31")).toBe("Nov 2024–Mar 2025");
    expect(topicLabel("clearing")).toBe("clearing or construction");
  });
});
