/**
 * Bea's rules as pure functions (docs/design/bea-character.html; ux-writing §6): which of her
 * states a moment shows, when she says "Bzz", and what she greets a site with.
 */
import type { BeaState } from "@/components/bea/bea";
import type { ReportOut } from "@/lib/api/types";
import type { Grade } from "@/lib/prototype/data";
import { GRADE_ORDER } from "@/lib/prototype/format";

export type BeaTurn = {
  id: number;
  status: "searching" | "writing" | "done" | "error";
  mode: "model" | "extractive" | "refusal" | null;
  citations: readonly unknown[];
  answer: string;
};

export interface GradeChange {
  from: Grade;
  to: Grade;
  direction: "up" | "down";
}

/** The site's latest grade change (reports newest first), if its latest Proof of Life moved. */
export function gradeChange(
  reports: readonly Pick<ReportOut, "grade">[] | undefined,
): GradeChange | null {
  const [latest, previous] = reports ?? [];
  if (!latest || !previous || latest.grade === previous.grade) return null;
  const to = latest.grade as Grade;
  const from = previous.grade as Grade;
  // GRADE_ORDER runs from AAA (best) to D.
  const up = GRADE_ORDER.indexOf(to) < GRADE_ORDER.indexOf(from);
  return { from, to, direction: up ? "up" : "down" };
}

/** What Bea shows for the conversation as a whole: the latest turn, else her greeting. */
export function beaState(
  turns: readonly BeaTurn[],
  {
    waking = false,
    change = null,
  }: { waking?: boolean; change?: GradeChange | null } = {},
): BeaState {
  const last = turns[turns.length - 1];
  if (!last) {
    if (change) return change.direction === "down" ? "downgrade" : "found";
    return "hello";
  }
  if (last.status === "searching") return waking ? "waking" : "thinking";
  if (last.status === "writing") return last.answer ? "hello" : "thinking";
  return answerState(last);
}

/** Bea beside one answer: found it (with evidence), can't answer, or hello. */
export function answerState(turn: BeaTurn): BeaState {
  if (turn.status !== "done") return "hello";
  if (turn.mode === "refusal") return "cant-answer";
  return turn.citations.length > 0 ? "found" : "hello";
}

/**
 * The answer Bea opens with "Bzz": the conversation's first one with something to say (never
 * a refusal), and only that one, never twice in a row.
 */
export function bzzTurnId(turns: readonly BeaTurn[]): number | null {
  const first = turns.find(
    (t) =>
      (t.status === "writing" || t.status === "done") &&
      t.answer !== "" &&
      t.mode !== "refusal",
  );
  return first?.id ?? null;
}

/** How Bea greets a site whose grade just moved (her notification in the character sheet). */
export function greetingFor(siteName: string, change: GradeChange): string {
  return change.direction === "down"
    ? `${siteName} was lowered ${change.from} → ${change.to}. Ask me why.`
    : `${siteName} was raised ${change.from} → ${change.to}. Ask me what changed.`;
}

/** How Bea appears in the Agent Trace: labelled with the model she ran on. */
export function agentLabel(
  agent: string | null | undefined,
  modelName: string,
): string | null {
  if (agent === "copilot") return `Bea (${modelName})`;
  return agent ?? null;
}
