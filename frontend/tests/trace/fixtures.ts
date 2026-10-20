import type { ReportOut, RunTrace } from "@/lib/api/types";

import asset from "../exchange/fixtures/asset.json";

export const ASSET_ID = "35df5b9e-90ff-4205-a82e-9ca6e0e06729";
export const RUN_ID = "66666666-6666-4666-8666-666666666601";
export const OLD_RUN_ID = "66666666-6666-4666-8666-666666666600";

const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

export const REPORT = asset.latest_report as unknown as ReportOut;

export function report(version: number, runId: string | null): ReportOut {
  return {
    ...REPORT,
    id: `77777777-7777-4777-8777-77777777770${version}`,
    version,
    run_id: runId,
    created_at: `2026-10-1${version}T08:00:00Z`,
  };
}

export function runTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    run_id: RUN_ID,
    asset_id: ASSET_ID,
    status: "succeeded",
    steps: [
      {
        step: "queued",
        status: "queued",
        prompt_tokens: 0,
        completion_tokens: 0,
        ts: "2026-10-19T08:00:00Z",
        llm_calls: [],
      },
      {
        step: "started",
        status: "running",
        pipeline: "orchestrator",
        prompt_tokens: 0,
        completion_tokens: 0,
        ts: "2026-10-19T08:00:01Z",
        llm_calls: [],
      },
      {
        step: "earth_obs",
        status: "ok",
        tool: "earth_obs",
        pipeline: "orchestrator",
        model: SUPER,
        prompt_tokens: 1840,
        completion_tokens: 310,
        latency_ms: 420,
        cost_usd: "0.000831",
        attempts: 1,
        ts: "2026-10-19T08:00:04Z",
        output: { data_version: "2026Q3", natural_fraction: 0.82 },
        llm_calls: [
          {
            id: 1,
            agent: "orchestrator",
            model: SUPER,
            tier: "orchestrator",
            status: "ok",
            prompt_tokens: 1840,
            completion_tokens: 310,
            latency_ms: 2100,
            cost_usd: "0.000831",
          },
        ],
      },
      {
        step: "news",
        status: "failed",
        tool: "news_scout",
        pipeline: "orchestrator",
        model: NANO,
        prompt_tokens: 2600,
        completion_tokens: 420,
        latency_ms: 3200,
        cost_usd: "0.000257",
        attempts: 2,
        error: "tavily_unavailable",
        ts: "2026-10-19T08:00:09Z",
        output: null,
        llm_calls: [
          {
            id: 2,
            agent: "news_scout",
            model: NANO,
            tier: "fast",
            status: "error",
            prompt_tokens: 2600,
            completion_tokens: 420,
            latency_ms: 3200,
            cost_usd: "0.000257",
          },
        ],
      },
      {
        step: "audit",
        status: "ok",
        tool: "auditor",
        pipeline: "orchestrator",
        model: ULTRA,
        prompt_tokens: 6200,
        completion_tokens: 980,
        latency_ms: 6800,
        cost_usd: "0.009140",
        attempts: 1,
        ts: "2026-10-19T08:00:16Z",
        output: { grade: "A", adjustment: 0 },
        llm_calls: [
          {
            id: 3,
            agent: "auditor",
            model: ULTRA,
            tier: "auditor",
            status: "ok",
            prompt_tokens: 6200,
            completion_tokens: 980,
            latency_ms: 6800,
            cost_usd: "0.009140",
          },
        ],
      },
      {
        // The orchestrator's closing turn rides on `done` with no tokens of its own (T27).
        step: "done",
        status: "succeeded",
        prompt_tokens: 0,
        completion_tokens: 0,
        ts: "2026-10-19T08:00:20Z",
        llm_calls: [
          {
            id: 4,
            agent: "orchestrator",
            model: SUPER,
            tier: "orchestrator",
            status: "ok",
            prompt_tokens: 500,
            completion_tokens: 20,
            latency_ms: 900,
            cost_usd: "0.000100",
          },
        ],
      },
    ],
    totals: {
      llm_calls: 4,
      prompt_tokens: 1840 + 2600 + 6200 + 500,
      completion_tokens: 310 + 420 + 980 + 20,
      cost_usd: "0.010328",
    },
    ...overrides,
  };
}
