import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthForm } from "@/components/proto/auth-form";
import { GradeBadge } from "@/components/proto/grade";
import { RatingPipeline } from "@/components/proto/rating-pipeline";
import { PrototypeProvider } from "@/lib/prototype/store";
import { createInitialWorld } from "@/lib/prototype/world";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/login",
}));

describe("AuthForm", () => {
  it("posts, so a submit before hydration never puts the password in the URL", () => {
    const { container } = render(
      <PrototypeProvider>
        <AuthForm mode="login" />
      </PrototypeProvider>,
    );
    expect(container.querySelector("form")).toHaveAttribute("method", "post");
  });
});

describe("GradeBadge", () => {
  it("has an accessible name", () => {
    render(<GradeBadge grade="A" health={76.2} />);
    expect(
      screen.getByRole("img", { name: /Grade A, health 76.2/ }),
    ).toBeInTheDocument();
  });
});

describe("RatingPipeline", () => {
  it("shows every step waiting until the run plays", () => {
    const run = createInitialWorld().runs[0];
    render(<RatingPipeline run={run} play={false} />);
    expect(screen.queryAllByText("done")).toHaveLength(0);
    expect(screen.getAllByText("waiting")).toHaveLength(run.steps.length);
  });
});
