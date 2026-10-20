import { describe, expect, it } from "vitest";

import {
  modelName,
  runOptions,
  traceAssetFromPath,
  traceMode,
  traceRows,
  traceTotals,
} from "@/lib/run-trace";

import { ASSET_ID, OLD_RUN_ID, RUN_ID, report, runTrace } from "./fixtures";

describe("traceRows", () => {
  it("labels each span and keeps the backend's numbers", () => {
    const rows = traceRows(runTrace());
    expect(rows.map((r) => r.label)).toEqual([
      "Run queued",
      "Start the run",
      "Read satellite metrics",
      "Scan local news",
      "Cross-check evidence and grade",
      "Seal the report",
    ]);
    const earth = rows[2]!;
    expect(earth).toMatchObject({
      kind: "llm",
      model: "nvidia/nemotron-3-super-120b-a12b",
      tokensIn: 1840,
      tokensOut: 310,
      latencyMs: 420,
      statusLabel: "Done",
      output: { data_version: "2026Q3", natural_fraction: 0.82 },
    });
    expect(rows[3]).toMatchObject({
      failed: true,
      statusLabel: "Failed",
      error: "tavily_unavailable",
      attempts: 2,
    });
    expect(rows[5]).toMatchObject({
      kind: "seal",
      model: "nvidia/nemotron-3-super-120b-a12b",
      tokensIn: 500,
      tokensOut: 20,
      costUsd: expect.closeTo(0.0001, 6),
    });
    expect(rows[0]!.kind).toBe("event");
    expect(rows[1]).toMatchObject({
      agent: "Orchestrator",
      statusLabel: "Started",
    });
  });

  it("keeps an unknown step's own name", () => {
    const [row] = traceRows(
      runTrace({
        steps: [
          {
            step: "scoring",
            status: "ok",
            tool: "scoring",
            prompt_tokens: 0,
            completion_tokens: 0,
            llm_calls: [],
          },
        ],
      }),
    );
    expect(row).toMatchObject({
      label: "scoring",
      agent: "scoring",
      kind: "tool",
    });
  });
});

describe("traceTotals", () => {
  it("uses the backend's totals of a sealed run; time spans the first to the last step", () => {
    expect(traceTotals(runTrace())).toEqual({
      llmCalls: 4,
      tokens: 1840 + 310 + 2600 + 420 + 6200 + 980 + 500 + 20,
      durationMs: 20_000,
      costUsd: expect.closeTo(0.010328, 6),
    });
    const totals = {
      llm_calls: 9,
      prompt_tokens: 100,
      completion_tokens: 1,
      cost_usd: "0.5",
    };
    expect(traceTotals(runTrace({ totals }))).toMatchObject({
      llmCalls: 9,
      tokens: 101,
      costUsd: 0.5,
    });
  });

  it("sums every step's model calls before the run seals, the done span's too", () => {
    expect(traceTotals(runTrace({ totals: null }))).toEqual({
      llmCalls: 4,
      tokens: 1840 + 310 + 2600 + 420 + 6200 + 980 + 500 + 20,
      durationMs: 20_000,
      costUsd: expect.closeTo(0.010328, 6),
    });
  });

  it("falls back to summed latencies without timestamps", () => {
    const steps = runTrace().steps.map((s) => ({ ...s, ts: null }));
    expect(traceTotals(runTrace({ steps })).durationMs).toBe(420 + 3200 + 6800);
  });
});

describe("modelName", () => {
  it("names known Token Factory models and keeps other ids", () => {
    expect(modelName("nvidia/nemotron-3-ultra-550b-a55b")).toBe(
      "Nemotron 3 Ultra",
    );
    expect(modelName("mock-model")).toBe("mock-model");
    expect(modelName(null)).toBeNull();
  });
});

describe("runOptions", () => {
  it("lists runs newest first, skipping seeded reports, with extra runs on top", () => {
    const reports = [report(3, RUN_ID), report(2, null), report(1, OLD_RUN_ID)];
    expect(runOptions(reports, [RUN_ID, "extra"])).toEqual([
      { runId: "extra", label: "Latest run" },
      { runId: RUN_ID, label: "Report v3 · A · 2026-10-13" },
      { runId: OLD_RUN_ID, label: "Report v1 · A · 2026-10-11" },
    ]);
    expect(runOptions([report(1, null)])).toEqual([]);
  });
});

describe("traceMode", () => {
  it("reads a real site from the path", () => {
    expect(traceAssetFromPath(`/asset/${ASSET_ID}`)).toBe(ASSET_ID);
    expect(traceAssetFromPath(`/steward/assets/${ASSET_ID}/ipo`)).toBe(
      ASSET_ID,
    );
    expect(traceAssetFromPath("/asset/xochimilco-wetland")).toBeNull();
    expect(traceAssetFromPath(null)).toBeNull();
  });

  it("shows real traces on real sites and for accounts; the prototype otherwise", () => {
    const asset = `/asset/${ASSET_ID}`;
    expect(
      traceMode({ pathname: asset, signedIn: false, tourActive: false }),
    ).toEqual({ kind: "asset", assetId: ASSET_ID });
    expect(
      traceMode({ pathname: "/", signedIn: true, tourActive: false }),
    ).toEqual({ kind: "world" });
    expect(
      traceMode({ pathname: "/", signedIn: false, tourActive: false }),
    ).toEqual({ kind: "prototype" });
    expect(
      traceMode({ pathname: asset, signedIn: true, tourActive: true }),
    ).toEqual({ kind: "prototype" });
  });
});
