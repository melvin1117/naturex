/**
 * The AI control room: which model does which job and why (ADR-0003), with this world's live
 * call stats from `GET /admin/ai-usage` merged in, and the deployment's spend and Tavily
 * credits as gauges. Pure, so it is easy to test; every number is the backend's.
 */
import type { AiUsage, ModelStats } from "./api/types";
import { type Actor, modelLabel } from "./trace-view";

export type Route = {
  model: string;
  actor: Actor;
  jobs: string;
  why: string;
  /** USD per 1M tokens, in and out (Token Factory catalogue, ADR-0003). */
  price: [number, number];
  reasoning: string;
};

export const ROUTING: Route[] = [
  {
    model: "nvidia/nemotron-3-super-120b-a12b",
    actor: "super",
    jobs: "Runs each rating: calls the tools, then thinks once to plan the follow-up searches and reads",
    why: "Reliable tool calling at a mid price; it thinks only on the one turn that needs judgment",
    price: [0.3, 0.9],
    reasoning: "Thinking on the planning turn only",
  },
  {
    model: "nvidia/Nemotron-3-Ultra-550b-a55b",
    actor: "ultra",
    jobs: "Audits each rating: weighs competing explanations, cites every claim, may adjust health by up to 10",
    why: "The deepest reasoning, used once per rating, where a wrong call costs most",
    price: [1, 3],
    reasoning: "Thinking on, up to 16,000 tokens",
  },
  {
    model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    actor: "nano",
    jobs: "Sorts the news results, reads articles for Super's questions, answers Copilot questions",
    why: "Fast and cheap for many small, well-defined reads",
    price: [0.06, 0.24],
    reasoning: "Thinking off",
  },
  {
    model: "nvidia/Nemotron-3.5-Super-VL",
    actor: "vision",
    jobs: "Compares a site's satellite views five years apart; reads field photos and title documents",
    why: "Nemotron's vision model; code checks every change it reports against the data",
    price: [0.3, 0.9],
    reasoning: "Thinking off, strict JSON",
  },
  {
    model: "Qwen/Qwen3-Embedding-8B",
    actor: "embed",
    jobs: "Finds the report passages the Copilot cites",
    why: "Token Factory serves no NVIDIA embedding model",
    price: [0.01, 0],
    reasoning: "No text generated",
  },
];

export type ModelRow = Route & {
  name: string;
  stats: ModelStats | null;
  /** Share of this world's model spend, 0–1. */
  share: number;
  /** ok / sent back by code / invalid / error, as fractions of calls. */
  outcomes: { ok: number; rejected: number; invalid: number; errors: number };
};

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

const NO_OUTCOMES = { ok: 0, rejected: 0, invalid: 0, errors: 0 };

function outcomes(stats: ModelStats | null): ModelRow["outcomes"] {
  if (!stats || stats.calls === 0) return NO_OUTCOMES;
  return {
    ok: stats.ok / stats.calls,
    rejected: stats.rejected / stats.calls,
    invalid: stats.invalid / stats.calls,
    errors: stats.errors / stats.calls,
  };
}

/** The routing table with this world's stats; models outside the routing (a fallback such as
 * Lightning) come last, labelled by their ID. */
export function modelRows(usage: AiUsage | undefined): ModelRow[] {
  const stats = usage?.models ?? [];
  const total = stats.reduce((n, m) => n + num(m.cost_usd), 0);
  const byModel = new Map(stats.map((m) => [m.model.toLowerCase(), m]));
  const routed = new Set(ROUTING.map((r) => r.model.toLowerCase()));
  const row = (route: Route, s: ModelStats | null): ModelRow => ({
    ...route,
    name: modelLabel(route.model),
    stats: s,
    share: s && total > 0 ? num(s.cost_usd) / total : 0,
    outcomes: outcomes(s),
  });
  return [
    ...ROUTING.map((r) => row(r, byModel.get(r.model.toLowerCase()) ?? null)),
    ...stats
      .filter((s) => !routed.has(s.model.toLowerCase()))
      .map((s) =>
        row(
          {
            model: s.model,
            actor: "nano",
            jobs: "A fallback when the routed model failed",
            why: "Keeps a rating going; the trace flags it",
            price: [0, 0],
            reasoning: "Thinking off",
          },
          s,
        ),
      ),
  ];
}

export type Gauges = {
  spentUsd: number;
  budgetUsd: number;
  /** 0–1 of the cap used. */
  spent: number;
  worldUsd: number;
  calls: number;
  sentBack: number;
  tavilyLeft: number | null;
  tavilyFloor: number;
};

export function gauges(usage: AiUsage | undefined): Gauges {
  const spentUsd = num(usage?.spent_usd);
  const budgetUsd = num(usage?.budget_usd);
  const models = usage?.models ?? [];
  return {
    spentUsd,
    budgetUsd,
    spent: budgetUsd > 0 ? Math.min(1, spentUsd / budgetUsd) : 0,
    worldUsd: num(usage?.world_cost_usd),
    calls: models.reduce((n, m) => n + m.calls, 0),
    sentBack: models.reduce((n, m) => n + m.rejected, 0),
    tavilyLeft: usage?.tavily_credits_left ?? null,
    tavilyFloor: usage?.tavily_min_credits_left ?? 0,
  };
}
