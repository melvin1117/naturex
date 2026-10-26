import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import HomePage from "@/app/page";

import nextConfig from "../next.config";
import { stubMotion } from "./motion";

// Leaflet draws the picture; the words and the ways on are what's tested here.
vi.mock("@/components/welcome/welcome-map", () => ({
  WelcomeMap: () => null,
}));

describe("the welcome at /", () => {
  it("says what WildWorth does in one sentence, and offers two ways on", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Welcome to WildWorth." }),
    ).toBeVisible();
    expect(
      screen.getByText(/We rate living land with satellites and AI/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Show me how/ })).toHaveAttribute(
      "href",
      "/how",
    );
    expect(
      screen.getByRole("link", { name: "Try it yourself" }),
    ).toHaveAttribute("href", "/sandbox");
    // Bea lives in Ask Bea, as on every page; here it opens the sandbox with her chat open.
    expect(
      screen.getByRole("link", { name: "Ask Bea AI assistant" }),
    ).toHaveAttribute("href", "/sandbox?ask=bea");
    // The sandbox line, once.
    expect(screen.getAllByText(/play money/)).toHaveLength(1);
  });

  it("shows its last frame at once for anyone who prefers reduced motion", () => {
    const { container } = render(<HomePage />);
    expect(container.querySelector("[data-intro]")).toHaveAttribute(
      "data-intro",
      "done",
    );
    expect(
      container.querySelector("[data-intro-overlay]"),
    ).not.toBeInTheDocument();
  });

  it("lets Bea write the greeting once per page load; any key ends it", () => {
    const motion = stubMotion({ reduce: false });
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    try {
      const first = render(<HomePage />);
      const intro = first.container.querySelector("[data-intro]");
      expect(intro).toHaveAttribute("data-intro", "writing");
      // She's decoration: the headline stays in the page for assistive tech throughout.
      expect(
        first.container.querySelector("[data-intro-overlay]"),
      ).toHaveAttribute("aria-hidden", "true");
      expect(
        screen.getByRole("heading", { name: "Welcome to WildWorth." }),
      ).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "Tab" });

      expect(intro).toHaveAttribute("data-intro", "done");
      expect(
        first.container.querySelector("[data-intro-overlay]"),
      ).not.toBeInTheDocument();
      first.unmount();

      // Back on the welcome from inside the app: no second flight.
      const again = render(<HomePage />);
      expect(again.container.querySelector("[data-intro]")).toHaveAttribute(
        "data-intro",
        "done",
      );
    } finally {
      now.mockRestore();
      motion.restore();
    }
  });
});

describe("old addresses", () => {
  it.each([
    ["/judge", "/how"],
    ["/login", "/sandbox"],
    ["/register", "/sandbox"],
    ["/list", "/sandbox/steward/list"],
    ["/ai", "/sandbox"],
    ["/sandbox/ai", "/sandbox"],
    ["/asset/:path*", "/sandbox/asset/:path*"],
    ["/trace/:path*", "/sandbox/trace/:path*"],
    ["/portfolio", "/sandbox/portfolio"],
    ["/steward", "/sandbox/steward"],
    ["/steward/:path*", "/sandbox/steward/:path*"],
    ["/admin", "/sandbox/admin"],
    ["/admin/:path*", "/sandbox/admin/:path*"],
  ])("%s lands on %s, temporarily", async (source, destination) => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual({
      source,
      destination,
      permanent: false,
    });
  });

  it("redirects nothing else", async () => {
    expect(await nextConfig.redirects!()).toHaveLength(13);
  });
});
