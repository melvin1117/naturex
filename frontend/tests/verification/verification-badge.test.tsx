import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VerificationBadge } from "@/components/verification/parts";
import type { VerificationLevel } from "@/lib/api/types";

/** The kebab-case name lucide gives each icon's class (`lucide-ww-stewards`, `lucide-file-clock`). */
function iconOf(level: VerificationLevel, text: string, publicBadge = false) {
  const { container } = render(
    <VerificationBadge level={level} publicBadge={publicBadge}>
      {text}
    </VerificationBadge>,
  );
  const svg = container.querySelector("svg");
  return Array.from(svg?.classList ?? []).find(
    (c) => c.startsWith("lucide-") && c !== "lucide",
  );
}

describe("VerificationBadge", () => {
  it("shows the Verified land seal only where documents were reviewed", () => {
    expect(iconOf("verified", "Documents reviewed by WildWorth", true)).toBe(
      "lucide-ww-verify",
    );
    expect(iconOf("verified", "Verified")).toBe("lucide-ww-verify");
  });

  it.each(["unverified", "documents_submitted", "rejected"] as const)(
    "shows the community on the public %s badge, which reads self-attested",
    (level) => {
      expect(iconOf(level, "Self-attested by the community", true)).toBe(
        "lucide-ww-stewards",
      );
    },
  );

  it("keeps a state icon on the Reviewer's and the listing's chips", () => {
    expect(iconOf("documents_submitted", "In review")).toBe(
      "lucide-file-clock",
    );
    expect(iconOf("rejected", "Rejected")).not.toBe("lucide-ww-stewards");
    expect(iconOf("revoked", "Verification revoked", true)).toBe(
      "lucide-shield-x",
    );
  });
});
