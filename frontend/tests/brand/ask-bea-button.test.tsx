import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AskBeaButton } from "@/components/bea/ask-bea-button";

import { stubBrowserApis } from "../exchange/render";

beforeAll(stubBrowserApis);

describe("AskBeaButton", () => {
  it("is called Ask Bea, shows her avatar and says she's an AI", () => {
    const onClick = vi.fn();
    const { container } = render(<AskBeaButton onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Ask Bea" });
    // Her avatar (the ringed medallion), sized by a class so the Button never shrinks her.
    const avatar = container.querySelector("svg[viewBox='0 0 120 120']");
    expect(avatar).toHaveClass("size-full");
    expect(button).toHaveTextContent("AI");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("names the model she runs on in its tooltip", async () => {
    render(<AskBeaButton />);
    fireEvent.focus(screen.getByRole("button", { name: "Ask Bea" }));
    expect(
      (await screen.findAllByText(/Runs on NVIDIA Nemotron 3 Nano/))[0],
    ).toBeInTheDocument();
  });

  it("stirs while hovered or focused, and not under reduced motion", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(
      join(__dirname, "../../src/app/globals.css"),
      "utf8",
    );
    expect(css).toContain(
      ".ask-bea:is(:hover, :focus-visible) .bea-anim .bea-wl",
    );
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(reduced).toContain(".bea-anim *");
  });
});
