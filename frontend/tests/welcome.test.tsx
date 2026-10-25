import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import HomePage from "@/app/page";

import nextConfig from "../next.config";

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
      screen.getByRole("img", { name: "Bea, the field guide" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Hi, I'm Bea.")).toBeInTheDocument();
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
    // The sandbox line, once.
    expect(screen.getAllByText(/play money/)).toHaveLength(1);
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
