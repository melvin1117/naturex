import { render, screen } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BRAND_ICONS,
  BeaIcon,
  BRAND_STROKE,
  WildWatchIcon,
} from "@/components/icons";

const ROOT = join(__dirname, "../../..");

describe("the WildWorth icon pack", () => {
  it("has one icon per key in the guidelines' GL object", () => {
    const html = readFileSync(
      join(ROOT, "docs/design/wildworth-brand-guidelines.html"),
      "utf8",
    );
    const gl = html.slice(
      html.indexOf("var GL={"),
      html.indexOf("};", html.indexOf("var GL={")),
    );
    const keys = [...gl.matchAll(/^\s{4}(\w+):'/gm)].map((m) => m[1]).sort();
    expect(Object.keys(BRAND_ICONS).sort()).toEqual(keys);
  });

  it("matches what the generator makes from the guidelines today", () => {
    // --check compares without writing, and exits non-zero (throwing here) when stale.
    const out = execFileSync(
      "node",
      [join(ROOT, "scripts/generate-brand-drawings.mjs"), "--check"],
      { encoding: "utf8" },
    );
    expect(out).toMatch(/^Checked \d+ icons and 6 Bea states/);
  });

  it("takes Lucide's props, at the brand's stroke, hidden unless labelled", () => {
    const { container } = render(
      <>
        <WildWatchIcon size={16} />
        <WildWatchIcon aria-label="WildWatch" strokeWidth={2} />
      </>,
    );
    const [plain] = container.querySelectorAll("svg");
    expect(plain).toHaveAttribute("width", "16");
    expect(plain).toHaveAttribute("stroke-width", String(BRAND_STROKE));
    expect(plain).toHaveAttribute("aria-hidden", "true");
    expect(plain).toHaveClass("ww-icon");
    const labelled = screen.getByLabelText("WildWatch");
    expect(labelled).toHaveAttribute("stroke-width", "2");
    // One lit part: the eye's pupil, filled lime with an ink outline.
    expect(plain!.querySelectorAll(".af")).toHaveLength(1);
  });

  it("draws Bea's icon as her own drawing, scaled down", () => {
    render(<BeaIcon aria-label="Ask Bea" size={20} />);
    const icon = screen.getByRole("img", { name: "Ask Bea" });
    expect(icon).toHaveAttribute("viewBox", "10 12 100 100");
    expect(icon).toHaveAttribute("width", "20");
    expect(icon.querySelector(".bea-wl")).not.toBeNull();
    expect(icon.querySelector("clipPath")?.id).toBeTruthy();
  });
});
