import { describe, expect, it } from "vitest";

import type { AiUsage, ModelStats } from "@/lib/api/types";
import { ROUTING, gauges, modelRows } from "@/lib/control-room";

function stats(model: string, over: Partial<ModelStats> = {}): ModelStats {
  return {
    model,
    calls: 10,
    ok: 8,
    rejected: 1,
    invalid: 1,
    errors: 0,
    p50_latency_ms: 900,
    p95_latency_ms: 4000,
    prompt_tokens: 1000,
    completion_tokens: 100,
    cost_usd: "0.0100",
    ...over,
  };
}

const usage: AiUsage = {
  models: [
    stats("nvidia/Nemotron-3-Ultra-550b-a55b", { cost_usd: "0.0300" }),
    stats("NVIDIA/nemotron-3-super-120b-a12b"),
    stats("nvidia/Nemotron-3_5-Lightning", {
      calls: 2,
      ok: 2,
      rejected: 0,
      invalid: 0,
    }),
  ],
  world_cost_usd: "0.0500",
  spent_usd: "5.00",
  budget_usd: "20",
  tavily_credits_left: 811,
  tavily_min_credits_left: 150,
};

describe("the AI control room", () => {
  it("lists every routed model with this world's stats, then any fallback", () => {
    const rows = modelRows(usage);
    expect(rows.map((r) => r.name)).toEqual([
      "Nemotron 3 Super",
      "Nemotron 3 Ultra",
      "Nemotron 3 Nano",
      "Nemotron 3.5 Super VL",
      "Qwen3 Embedding 8B",
      "Nemotron 3.5 Lightning",
    ]);
    const ultra = rows[1]!;
    expect(ultra.stats?.calls).toBe(10);
    expect(ultra.share).toBeCloseTo(0.6);
    expect(ultra.outcomes).toEqual({
      ok: 0.8,
      rejected: 0.1,
      invalid: 0.1,
      errors: 0,
    });
    expect(rows[0]!.stats).not.toBeNull(); // matched case-insensitively
    expect(rows[2]!.stats).toBeNull();
    expect(rows.at(-1)!.jobs).toMatch(/fallback/);
    expect(ROUTING.every((r) => r.why && r.jobs)).toBe(true);
  });

  it("turns spend and credits into gauges", () => {
    expect(gauges(usage)).toEqual({
      spentUsd: 5,
      budgetUsd: 20,
      spent: 0.25,
      worldUsd: 0.05,
      calls: 22,
      sentBack: 2,
      tavilyLeft: 811,
      tavilyFloor: 150,
    });
    expect(gauges(undefined)).toMatchObject({
      calls: 0,
      spent: 0,
      tavilyLeft: null,
    });
  });
});
