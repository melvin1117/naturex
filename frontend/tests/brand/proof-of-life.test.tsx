import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProofOfLifeSeal,
  ProofOfLifeShareCard,
} from "@/components/brand/proof-of-life";
import { reportQuarter } from "@/lib/prototype/format";

const nav = vi.hoisted(() => ({ pathname: "/asset/x" }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  nav.pathname = "/asset/x";
});

afterEach(() => vi.restoreAllMocks());

/** The seal's dot columns: one `<g>` per point of health. */
function columns(container: HTMLElement): SVGGElement[] {
  return [...container.querySelectorAll<SVGGElement>("svg > g")];
}

describe("ProofOfLifeSeal", () => {
  it("is the DotRing: 100 columns of 5 rings, lit to the score in the grade's colour", () => {
    const { container } = render(
      <ProofOfLifeSeal
        health={77.6}
        grade="A"
        quarter="Q3 2026"
        siteName="Xochimilco wetland"
      />,
    );
    const all = columns(container);
    expect(all).toHaveLength(100);
    expect(
      Math.max(...all.map((g) => g.querySelectorAll("circle").length)),
    ).toBe(5);
    expect(
      all.filter((g) => g.classList.contains("fill-grade-a")),
    ).toHaveLength(78);
    expect(all[78]).toHaveClass("fill-foreground/12");
  });

  it("names the site, quarter, grade and health, and shows the grade and quarter in the centre", () => {
    render(
      <ProofOfLifeSeal
        health={63.84}
        grade="BBB"
        quarter="Q4 2026"
        siteName="Celestún mangrove"
      />,
    );
    const seal = screen.getByRole("img", {
      name: "Proof of Life seal for Celestún mangrove, Q4 2026: grade BBB, health 63.8 out of 100",
    });
    expect(within(seal).getByText("Proof of Life")).toBeInTheDocument();
    expect(within(seal).getByText("BBB")).toHaveClass("font-serif");
    expect(within(seal).getByText("Q4 2026")).toHaveClass("font-mono");
    // No counting numeral: the seal is a verdict, not the live dial.
    expect(within(seal).queryByText(/63/)).not.toBeInTheDocument();
  });

  it("lights lime on forest, and never past 100", () => {
    const { container } = render(
      <ProofOfLifeSeal
        health={140}
        grade="AAA"
        quarter="Q3 2026"
        siteName="Osa forest"
        ground="forest"
      />,
    );
    expect(
      columns(container).filter((g) => g.classList.contains("fill-lime")),
    ).toHaveLength(100);
    expect(screen.getByRole("img")).toHaveAccessibleName(
      /health 100\.0 out of 100/,
    );
  });

  it("rises once and stamps the grade after the dots", () => {
    render(
      <ProofOfLifeSeal
        health={77.6}
        grade="A"
        quarter="Q3 2026"
        siteName="Xochimilco wetland"
        rise
      />,
    );
    const grade = screen.getByText("A");
    expect(grade).toHaveClass("nx-stamp");
    expect(grade.style.animationDelay).toBe("550ms");
  });
});

describe("ProofOfLifeShareCard", () => {
  const card = (
    <ProofOfLifeShareCard
      siteName="Xochimilco wetland"
      health={77.6}
      grade="A"
      quarter="Q3 2026"
    />
  );

  it("says what the site rates, in which quarter, in the sandbox", () => {
    render(card);
    const share = screen.getByRole("group", { name: "Share card" });
    expect(within(share).getByText("Xochimilco wetland rates A")).toBeVisible();
    expect(
      within(share).getByText("Proof of Life · Q3 2026 · Sandbox"),
    ).toBeVisible();
    expect(share).toHaveTextContent(/^WildWorth/);
    expect(
      within(share).getByRole("img", { name: /^Proof of Life seal for/ }),
    ).toBeInTheDocument();
  });

  it("copies a link to the report, so the evidence is one click away", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(card);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy link to this report" }),
    );
    expect(
      await screen.findByRole("button", { name: "Link copied" }),
    ).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}${window.location.pathname}?tab=report`,
    );
  });

  it("has no link to copy inside a visitor's sandbox", () => {
    nav.pathname = "/sandbox/asset/x";
    render(card);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("reportQuarter", () => {
  it("is the rating period, else the quarter the report was issued in", () => {
    expect(reportQuarter("2026Q3", "2026-11-02T00:00:00Z")).toBe("Q3 2026");
    expect(reportQuarter(null, "2026-11-02T00:00:00Z")).toBe("Q4 2026");
    expect(reportQuarter(null, "2027-01-01T00:00:00Z")).toBe("Q1 2027");
  });
});
