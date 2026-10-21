import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IpoLaunched } from "@/components/ipo-outcome";
import type { IpoOut } from "@/lib/api/types";

import { stubMotion } from "../motion";

const ASSET_ID = "33333333-3333-4333-8333-333333333333";

function ipo(overrides: Partial<IpoOut> = {}): IpoOut {
  return {
    asset_id: ASSET_ID,
    total_shares: 1_000_000,
    ipo_price: "10.5173",
    retained_pct: "51.00",
    shares_offered: 490_000,
    retained_shares: 510_000,
    launched_at: "2026-10-19T00:00:00Z",
    ...overrides,
  } as IpoOut;
}

let motion: ReturnType<typeof stubMotion> | null = null;
afterEach(() => motion?.restore());

function renderLaunched(offer: IpoOut) {
  return render(
    <IpoLaunched
      assetId={ASSET_ID}
      name="Río Claro Forest"
      ipo={offer}
      homeHref="/steward"
    />,
  );
}

const litColumns = (container: HTMLElement) =>
  container.querySelectorAll("g.nx-dot-on").length;

describe("IpoLaunched, the opening bell (#216)", () => {
  it("lights the split of the stake as the launch set it", () => {
    motion = stubMotion();
    const { container } = renderLaunched(ipo());
    expect(
      screen.getByRole("img", {
        name: "Your community keeps 51% of the stake; 49% is on offer to supporters.",
      }),
    ).toBeInTheDocument();
    expect(litColumns(container)).toBe(100);
    expect(
      screen.getByRole("heading", {
        name: "Río Claro Forest is open to supporters",
      }),
    ).toHaveFocus();
  });

  it("under reduced motion shows the same split at once", () => {
    motion = stubMotion({ reduce: true });
    const { container } = renderLaunched(ipo());
    expect(
      screen.getByRole("img", {
        name: /keeps 51% of the stake; 49% is on offer/,
      }),
    ).toBeInTheDocument();
    expect(litColumns(container)).toBe(0);
    expect(
      screen.getByText("Opening price · play money").parentElement,
    ).toHaveTextContent("$10.5173 per unit");
  });

  it("takes both shares from the API's figures, decimals included", () => {
    motion = stubMotion({ reduce: true });
    renderLaunched(
      ipo({
        retained_pct: "50.50",
        shares_offered: 495_000,
        retained_shares: 505_000,
      }),
    );
    expect(
      screen.getByRole("img", {
        name: "Your community keeps 50.5% of the stake; 49.5% is on offer to supporters.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("50.5%")).toBeVisible();
    expect(
      screen.getByText("Your community keeps").parentElement,
    ).toHaveTextContent("505,000 units");
  });
});
