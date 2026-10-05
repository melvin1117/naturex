import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteHeader } from "@/components/site-header";

describe("SiteHeader", () => {
  it("links to the marketplace, listing and portfolio pages", () => {
    render(<SiteHeader />);

    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav)
      .getAllByRole("link")
      .map((link) => [link.textContent, link.getAttribute("href")]);

    expect(links).toEqual([
      ["Marketplace", "/"],
      ["List land", "/list"],
      ["Portfolio", "/portfolio"],
    ]);
  });

  it("keeps the admin Time Machine out of the main navigation", () => {
    render(<SiteHeader />);

    expect(
      screen.queryByRole("link", { name: /admin|time machine/i }),
    ).not.toBeInTheDocument();
  });
});
