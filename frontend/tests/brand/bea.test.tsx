import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Bea } from "@/components/bea/bea";
import { BEA_STATE_LABEL, type BeaState } from "@/components/bea/states";

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

  it("hops once when a grade goes up, and shakes once when one goes down", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Bea state="found" size={40} />);
    const root = () => container.firstElementChild!;
    // A cited answer turns her to "found" without a hop: only a grade change makes her react.
    rerender(<Bea state="thinking" size={40} />);
    rerender(<Bea state="found" size={40} />);
    expect(root()).not.toHaveClass("bea-react-up");

    rerender(<Bea state="found" size={40} react="up" />);
    expect(root()).toHaveClass("bea-react-up");
    act(() => vi.advanceTimersByTime(750));
    expect(root()).not.toHaveClass("bea-react-up");

    rerender(<Bea state="downgrade" size={40} react="down" />);
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

  it("settles within 5 s at rest, looping only while she thinks or wakes (WCAG 2.2.2)", () => {
    const css = readFileSync(
      join(ROOT, "frontend/src/app/globals.css"),
      "utf8",
    );
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf("}", start));
    };
    expect(rule(".bea-anim .bea-bob")).toContain("3.6s ease-in-out 1;");
    expect(rule(".bea-anim .eyes")).toContain("5s 1;");
    // 14 alternating flaps of 0.32 s: 4.48 s, ending at rest.
    expect(rule(".bea-anim .bea-wl")).toContain(
      "0.32s ease-in-out 14 alternate",
    );
    expect(rule(".bea-anim .bea-wr")).toContain(
      "0.32s ease-in-out 14 alternate",
    );
    expect(rule(".bea-anim .s-think .bea-ant")).toContain("infinite");
  });
});
