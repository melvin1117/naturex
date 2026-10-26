import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GradeBadge } from "@/components/proto/grade";

describe("GradeBadge", () => {
  it("has an accessible name", () => {
    render(<GradeBadge grade="A" health={76.2} />);
    expect(
      screen.getByRole("img", { name: /Grade A, health 76.2/ }),
    ).toBeInTheDocument();
  });
});
