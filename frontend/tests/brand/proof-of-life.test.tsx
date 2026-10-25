import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
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

const ROOT = join(__dirname, "../../..");

/** The guidelines' own `sealInner()`, run as written (it only needs `clamp`). */
function guidelinesSeal(score: number, lit: string, quarter: string): string {
  const html = readFileSync(
    join(ROOT, "docs/design/wildworth-brand-guidelines.html"),
    "utf8",
  );
  const between = (from: string, to: string) =>
    html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  const code = [
    between("var GRADES=", "function ok("),
    between("function ok(", "function grade("),
    between("function grade(", "var C="),
    between("function clamp(", "\n"),
    between("function sealInner(", "function sealSvg("),
    `result = sealInner(${score}, { lit: ${JSON.stringify(lit)}, q: ${JSON.stringify(quarter)} });`,
  ].join("\n");
  const context: { result?: string } = {};
  vm.runInNewContext(code, context);
  return context.result!;
}

const attrs = (tag: string): Record<string, string> =>
  Object.fromEntries(
    [...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );

describe("ProofOfLifeSeal", () => {
  it("draws the guidelines' seal: one ring of 100 dots, lit to the score", () => {
    const theirs = guidelinesSeal(77.6, "LIT", "Q3 2026");
    const circles = [...theirs.matchAll(/<circle[^>]*\/>/g)].map((m) =>
      attrs(m[0]),
    );
    const { container } = render(
      <ProofOfLifeSeal
        health={77.6}
        grade="A"
        quarter="Q3 2026"
        siteName="Xochimilco wetland"
      />,
    );
    const ours = [...container.querySelectorAll("circle")];
    expect(ours).toHaveLength(circles.length);
    expect(circles).toHaveLength(100);
    ours.forEach((c, i) => {
      const t = circles[i]!;
      expect(Number(c.getAttribute("cx"))).toBe(Number(t.cx));
      expect(Number(c.getAttribute("cy"))).toBe(Number(t.cy));
      expect(Number(c.getAttribute("r"))).toBe(Number(t.r));
      const lit = t.fill === "LIT";
      expect(c.classList.contains("fill-grade-a")).toBe(lit);
      if (!lit)
        expect(Number(c.getAttribute("opacity"))).toBe(Number(t.opacity));
    });
    expect(circles.filter((c) => c.fill === "LIT")).toHaveLength(78);
    // Not the live dial: a single ring, every dot the same distance from the centre.
    const radii = new Set(
      ours.map((c) =>
        Math.round(
          Math.hypot(
            Number(c.getAttribute("cx")) - 50,
            Number(c.getAttribute("cy")) - 50,
          ),
        ),
      ),
    );
    expect([...radii]).toEqual([42]);
  });

  it("sets its stamp where and how the guidelines do", () => {
    const theirs = [
      ...guidelinesSeal(63.8, "LIT", "Q4 2026").matchAll(
        /<text([^>]*)>([^<]*)<\/text>/g,
      ),
    ].map((m): Record<string, string> => ({ ...attrs(m[1]!), text: m[2]! }));
    const { container } = render(
      <ProofOfLifeSeal
        health={63.8}
        grade="BBB"
        quarter="Q4 2026"
        siteName="Celestún mangrove"
      />,
    );
    const ours = [...container.querySelectorAll("text")].map((t) => ({
      text: t.textContent,
      y: t.getAttribute("y"),
      size: t.getAttribute("font-size"),
      tracking: t.getAttribute("letter-spacing"),
      opacity: t.getAttribute("opacity"),
    }));
    for (const t of theirs) {
      const mine = ours.find((o) => o.text === t.text)!;
      expect(mine, t.text).toBeDefined();
      expect(Number(mine.y)).toBe(Number(t.y));
      expect(Number(mine.size)).toBe(Number(t["font-size"]));
      if (t["letter-spacing"])
        expect(Number(mine.tracking)).toBe(Number(t["letter-spacing"]));
      if (t.opacity) expect(Number(mine.opacity)).toBe(Number(t.opacity));
    }
    expect(theirs.map((t) => t.text)).toEqual([
      "PROOF OF LIFE",
      "Q4 2026",
      "BBB",
    ]);
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
    expect(within(seal).getByText("PROOF OF LIFE")).toBeInTheDocument();
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
      [...container.querySelectorAll("circle")].filter((c) =>
        c.classList.contains("fill-lime"),
      ),
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
    expect(grade).toHaveClass("ww-stamp");
    expect(grade.style.animationDelay).toBe("550ms");
    // Stamped about its own centre, not the seal's corner.
    expect(grade.style.transformOrigin).toBe("center");
    const lit = document.querySelectorAll("circle.ww-dot-on");
    expect(lit).toHaveLength(78);
    expect((lit[0] as SVGElement).style.animationDelay).toBe("0ms");
    expect((lit[77] as SVGElement).style.animationDelay).toBe("543ms");
  });
});

describe("ProofOfLifeShareCard", () => {
  const card = (
    <ProofOfLifeShareCard
      version={2}
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

  it("copies a link to this version of the report, so the evidence is one click away", async () => {
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
      `${window.location.origin}${window.location.pathname}?tab=report&version=2`,
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
