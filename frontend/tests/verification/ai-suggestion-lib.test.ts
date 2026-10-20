import { describe, expect, it } from "vitest";

import { UNTRUSTED_MAX_CHARS, untrustedText } from "@/lib/ai-suggestion";

describe("untrustedText", () => {
  it("returns short text unchanged, trimmed, and null when empty", () => {
    expect(untrustedText("  Ejido Río Claro ")).toBe("Ejido Río Claro");
    expect(untrustedText("   ")).toBeNull();
    expect(untrustedText(null)).toBeNull();
  });

  it("caps by code points, never splitting an emoji at the cap", () => {
    const text = `${"x".repeat(UNTRUSTED_MAX_CHARS - 2)}😀${"y".repeat(10)}`;

    const shown = untrustedText(text)!;

    expect(shown).toBe(`${"x".repeat(UNTRUSTED_MAX_CHARS - 2)}😀…`);
    expect(Array.from(shown)).toHaveLength(UNTRUSTED_MAX_CHARS);
    expect(shown).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("counts an emoji as one character when deciding to cap", () => {
    const text = "😀".repeat(UNTRUSTED_MAX_CHARS);
    expect(untrustedText(text)).toBe(text);
  });
});
