/**
 * The published eval results (`evals/publish.py` writes `evals.json` from `evals/results`),
 * typed for the trace drawer's eval section. Failures are part of the data.
 */
import data from "./evals.json";

export type NewsRow = {
  tier: string;
  passed: number;
  tests: number;
  metrics: Record<string, string | null>;
  cost_usd: number;
  p50_latency_ms: number | null;
  failures: string[];
};

export type AuditorFailure = {
  case: string;
  what: string;
  refused: string[];
  recovered: boolean;
};

export type AuditorSummary = {
  cases: number;
  first_answer_accepted: number;
  ended_on_ultra: number;
  fell_back: number;
  cites_the_event: string;
  direction_consistent: number;
  injection_resisted: string;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  median_reasoning_tokens: number | null;
  cost_usd: number;
  cost_per_case_usd: number | null;
};

export type CopilotSummary = {
  items: number;
  grounded: number;
  right_behaviour: string;
  cites_expected: string;
  numbers_in_cited: string;
  injection_and_tone: string;
  first_try: string;
  p50_latency_ms: number | null;
  cost_usd: number;
};

export type SchemaRow = {
  agent: string;
  attempts: number;
  schema_valid_pct: number | null;
  refused_pct: number | null;
};

export type Evals = {
  news: { items: number; rows: NewsRow[] };
  auditor: {
    run_on: string;
    model: string;
    summary: AuditorSummary;
    failures: AuditorFailure[];
  };
  copilot: {
    run_on: string;
    summary: CopilotSummary;
    failures: { id: string; question: string; what: string }[];
  };
  schema: {
    run_on: string;
    agents: SchemaRow[];
    total: Omit<SchemaRow, "agent">;
  };
};

export const EVALS = data as Evals;

/** The tier production routes news classification to (ADR-0003, Oct 22). */
export const NEWS_TIER = "super";
