import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SANDBOX_NOTICE, SandboxBanner } from "@/components/sandbox-banner";

describe("SandboxBanner", () => {
  it("says the market is play money and not a real security", () => {
    render(<SandboxBanner />);

    expect(screen.getByText(SANDBOX_NOTICE)).toBeInTheDocument();
    expect(SANDBOX_NOTICE).toMatch(/play money/i);
    expect(SANDBOX_NOTICE).toMatch(/not a real security/i);
  });

  it("is a labelled note, not an assertive alert", () => {
    render(<SandboxBanner />);

    expect(
      screen.getByRole("note", { name: "Sandbox notice" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
