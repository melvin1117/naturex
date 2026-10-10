import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AdminPage from "@/app/admin/page";
import AssetPage from "@/app/asset/[id]/page";
import DevUiPage from "@/app/dev/ui/page";
import ListPage from "@/app/list/page";
import MarketplacePage from "@/app/page";
import NotFound from "@/app/not-found";
import PortfolioPage from "@/app/portfolio/page";

// Live data is covered in tests/lib/hooks.test.tsx; route stubs render without a world.
vi.mock("@/components/data-layer-panel", () => ({
  DataLayerPanel: () => null,
}));

describe("route stubs", () => {
  it.each([
    ["/", MarketplacePage, "Marketplace"],
    ["/list", ListPage, "List your land"],
    ["/portfolio", PortfolioPage, "Portfolio"],
    ["/admin", AdminPage, "Time Machine"],
    ["/dev/ui", DevUiPage, "UI kit"],
    ["404", NotFound, "Page not found"],
  ])("%s renders its heading", (_path, Page, heading) => {
    render(<Page />);

    expect(
      screen.getByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  it("/asset/[id] shows the id from the URL", async () => {
    render(
      await AssetPage({
        params: Promise.resolve({ id: "wetland-1" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Asset wetland-1" }),
    ).toBeInTheDocument();
  });
});
