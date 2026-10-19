import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownText, parseBlocks } from "@/components/markdown-text";

describe("MarkdownText", () => {
  it("renders Markdown structure as React elements", () => {
    const { container } = render(
      <MarkdownText
        text={
          "## Report\n\nHealth is **76.2** [score:base_health].\n\n- one\n- *two*\n\n1. first"
        }
      />,
    );
    expect(screen.getByText("Report")).toBeInTheDocument();
    expect(screen.getByText("76.2").tagName).toBe("STRONG");
    expect(screen.getByText("score:base_health").tagName).toBe("SPAN");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(screen.getByText("two").tagName).toBe("EM");
    expect(container.querySelectorAll("ol li")).toHaveLength(1);
  });

  it("never interprets raw HTML or follows links", () => {
    const { container } = render(
      <MarkdownText
        text={
          'Hi <img src=x onerror="alert(1)"> <script>alert(2)</script> [click](javascript:alert(3))'
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain("click");
    expect(container.textContent).not.toContain("javascript:");
  });

  it("joins wrapped lines into one paragraph", () => {
    expect(parseBlocks("a\nb\n\nc")).toEqual([
      { kind: "paragraph", text: "a b" },
      { kind: "paragraph", text: "c" },
    ]);
  });
});
