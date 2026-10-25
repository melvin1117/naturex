import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EMPTY_CHAIN, StoryChain } from "@/components/story/story-chain";

describe("StoryChain", () => {
  it("can be reached by keyboard, since it scrolls sideways on a phone", () => {
    render(<StoryChain chain={EMPTY_CHAIN} reducedMotion />);
    const chain = screen.getByRole("region", {
      name: "How the land's health reaches its community",
    });
    expect(chain).toHaveAttribute("tabindex", "0");
  });
});
