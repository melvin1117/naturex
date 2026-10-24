import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Bea, BEA_STATE_LABEL, type BeaState } from "@/components/bea/bea";

const ROOT = join(__dirname, "../../..");

const DRAWN_AS: Record<BeaState, string> = {
  hello: "s-neutral",
  thinking: "s-think",
  found: "s-happy",
  downgrade: "s-alert",
  "cant-answer": "s-sad",
  waking: "s-sleep",
};

afterEach(() => vi.useRealTimers());

describe("Bea", () => {
  it.each(Object.entries(DRAWN_AS))(
    "draws %s from the character sheet's %s",
    (state, drawing) => {
      const { container } = render(<Bea state={state as BeaState} size={96} />);
      expect(container.querySelector(`g.${drawing}`)).not.toBeNull();
      expect(
        screen.getByRole("img", {
          name: `Bea, ${BEA_STATE_LABEL[state as BeaState].toLowerCase()}`,
        }),
      ).toBeInTheDocument();
    },
  );

  it("is the ringed avatar below 64 px and drawn in full from 64 px", () => {
    const { container, rerender } = render(<Bea size={40} />);
    expect(container.querySelector("svg")).toHaveAttribute(
      "viewBox",
      "0 0 120 120",
    );
    expect(container.querySelector("circle.bea-ground")).not.toBeNull();
    rerender(<Bea size={64} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("viewBox", "0 0 120 124");
    expect(svg).toHaveClass("bea-bob");
  });

  it("hides from assistive tech when the words beside her say it", () => {
    const { container } = render(<Bea state="thinking" size={34} label="" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("hops once when she finds something, and shakes once at a downgrade", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Bea state="found" size={40} />);
    const root = () => container.firstElementChild!;
    // No reaction to the state she arrives in.
    expect(root()).not.toHaveClass("bea-react-up");

    rerender(<Bea state="thinking" size={40} />);
    rerender(<Bea state="found" size={40} />);
    expect(root()).toHaveClass("bea-react-up");
    act(() => vi.advanceTimersByTime(750));
    expect(root()).not.toHaveClass("bea-react-up");

    rerender(<Bea state="downgrade" size={40} />);
    expect(root()).toHaveClass("bea-react-down");
    act(() => vi.advanceTimersByTime(600));
    expect(root()).not.toHaveClass("bea-react-down");
  });

  it("stops every motion under prefers-reduced-motion", () => {
    const css = readFileSync(
      join(ROOT, "frontend/src/app/globals.css"),
      "utf8",
    );
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    for (const cls of [".bea-anim", ".bea-react-up", ".bea-react-down"])
      expect(reduced).toContain(cls);
  });
});
