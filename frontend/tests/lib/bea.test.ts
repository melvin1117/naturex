import { describe, expect, it } from "vitest";

import {
  agentLabel,
  answerState,
  beaState,
  bzzTurnId,
  gradeChange,
  greetingFor,
  type BeaTurn,
} from "@/lib/bea";

function turn(over: Partial<BeaTurn> & { id: number }): BeaTurn {
  return {
    status: "done",
    mode: "model",
    citations: [{ ref: "R2" }],
    answer: "An answer [R2].",
    ...over,
  };
}

describe("gradeChange", () => {
  it("reads the latest Proof of Life against the one before (newest first)", () => {
    expect(gradeChange([{ grade: "BB" }, { grade: "A" }])).toEqual({
      from: "A",
      to: "BB",
      direction: "down",
    });
    expect(gradeChange([{ grade: "AA" }, { grade: "A" }])).toEqual({
      from: "A",
      to: "AA",
      direction: "up",
    });
  });

  it("is null without two reports or when the grade held", () => {
    expect(gradeChange(undefined)).toBeNull();
    expect(gradeChange([{ grade: "A" }])).toBeNull();
    expect(gradeChange([{ grade: "A" }, { grade: "A" }])).toBeNull();
  });
});

describe("beaState", () => {
  it("says hello before the first question, or reacts to the site's grade change", () => {
    expect(beaState([])).toBe("hello");
    expect(
      beaState([], { change: { from: "A", to: "BB", direction: "down" } }),
    ).toBe("downgrade");
    expect(
      beaState([], { change: { from: "A", to: "AA", direction: "up" } }),
    ).toBe("found");
  });

  it("thinks while she searches, and wakes up when the servers are slow", () => {
    const searching = turn({ id: 1, status: "searching", answer: "" });
    expect(beaState([searching])).toBe("thinking");
    expect(beaState([searching], { waking: true })).toBe("waking");
  });

  it("keeps thinking until the first words arrive", () => {
    expect(beaState([turn({ id: 1, status: "writing", answer: "" })])).toBe(
      "thinking",
    );
    expect(beaState([turn({ id: 1, status: "writing" })])).toBe("hello");
  });

  it("follows the latest answer", () => {
    expect(beaState([turn({ id: 1 })])).toBe("found");
    expect(
      beaState([
        turn({ id: 1 }),
        turn({ id: 2, mode: "refusal", citations: [] }),
      ]),
    ).toBe("cant-answer");
  });
});

describe("answerState", () => {
  it("is found with evidence, can't answer on a refusal, else hello", () => {
    expect(answerState(turn({ id: 1 }))).toBe("found");
    expect(answerState(turn({ id: 1, mode: "refusal", citations: [] }))).toBe(
      "cant-answer",
    );
    expect(answerState(turn({ id: 1, citations: [] }))).toBe("hello");
    expect(answerState(turn({ id: 1, status: "error" }))).toBe("hello");
  });
});

describe("bzzTurnId", () => {
  it("opens only the first answer with something to say", () => {
    expect(bzzTurnId([turn({ id: 1 }), turn({ id: 2 })])).toBe(1);
  });

  it("never opens a refusal, an error or an empty answer", () => {
    expect(
      bzzTurnId([
        turn({ id: 1, mode: "refusal", citations: [] }),
        turn({ id: 2, status: "error", answer: "" }),
        turn({ id: 3, status: "searching", answer: "", mode: null }),
      ]),
    ).toBeNull();
    expect(bzzTurnId([turn({ id: 1, mode: "refusal" }), turn({ id: 2 })])).toBe(
      2,
    );
  });
});

describe("greetingFor", () => {
  it("points at the change and invites the question", () => {
    expect(
      greetingFor("Osa forest", { from: "A", to: "BB", direction: "down" }),
    ).toBe("Osa forest was lowered A → BB. Ask me why.");
    expect(
      greetingFor("Osa forest", { from: "A", to: "AA", direction: "up" }),
    ).toBe("Osa forest was raised A → AA. Ask me what changed.");
  });
});

describe("agentLabel", () => {
  it("names Bea with the model that ran her, and leaves other agents alone", () => {
    expect(agentLabel("copilot", "Nemotron 3 Nano")).toBe(
      "Bea (Nemotron 3 Nano)",
    );
    expect(agentLabel("auditor", "Nemotron 3 Super")).toBe("auditor");
    expect(agentLabel(null, "Nemotron 3 Super")).toBeNull();
  });
});
