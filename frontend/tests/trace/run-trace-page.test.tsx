import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { RunTracePage } from "@/components/trace/run-trace-page";
import { VerdictStrip } from "@/components/trace/verdict-strip";
import type { ReportOut } from "@/lib/api/types";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { json } from "../lib/helpers";
import celestun from "./fixtures/run-celestun.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/trace/${celestun.run_id}`,
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(stubBrowserApis);

function renderPage() {
  return renderExchange(<RunTracePage runId={celestun.run_id} />, {
    [`GET /runs/${celestun.run_id}/trace`]: () => json(celestun),
    [`GET /assets/${celestun.asset_id}`]: () =>
      json({ id: celestun.asset_id, name: "Ría Celestún Mangrove" }),
  });
}

describe("RunTracePage (a real run recorded on Oct 22)", () => {
  it("leads with the verdict, the judge and the receipt, then the story", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", {
        name: "How Ría Celestún Mangrove was rated",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Judged by Nemotron 3 Ultra")).toBeInTheDocument();
    expect(
      screen.getByText(/6 model calls · 4 web searches/),
    ).toBeInTheDocument();
    expect(screen.getByText(/less than Ultra alone/)).toBeInTheDocument();
    const story = screen.getByRole("list", {
      name: "What happened in this run",
    });
    expect(
      within(story).getByText(/^Tavily ran 4 web searches \(1 in Spanish\)/),
    ).toBeVisible();
  });

  it("shows the weighed case with links to the news it cites", async () => {
    renderPage();
    const tab = await screen.findByRole("tab", { name: "Reasoning" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);

    expect(
      await screen.findByRole("heading", {
        name: "The explanations it weighed",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Supported").length).toBeGreaterThan(0);
    const sources = screen.getAllByRole("link", {
      name: /opens the source in a new tab/,
    });
    expect(sources[0]).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(sources[0]!.getAttribute("href")).toMatch(/^https:\/\//);
    fireEvent.click(screen.getByRole("button", { name: /own notes/ }));
    expect(screen.getByText(/They are not evidence/)).toBeVisible();
  });

  it("explains each step of the flow on selection", async () => {
    renderPage();
    const tab = await screen.findByRole("tab", { name: "Flow" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);

    const steps = await screen.findByRole("list", {
      name: "The steps of this run",
    });
    fireEvent.click(within(steps).getByRole("button", { name: /^Local news/ }));
    const panel = screen.getByRole("complementary", { name: "Selected step" });
    expect(within(panel).getByText("Tavily searches")).toBeVisible();
    expect(within(panel).getAllByText(/credits/).length).toBe(4);
  });
});

describe("VerdictStrip", () => {
  const report = {
    run_id: celestun.run_id,
    auditor: {
      verdict:
        "Clearing is reported [event:abc] but not yet seen [metric:forest_loss_12m_ha].",
      auditor_adjustment: -2,
    },
  } as unknown as ReportOut;

  it("shows the verdict without citations and links to the run's trace", () => {
    render(<VerdictStrip report={report} />);

    expect(
      screen.getByText("Clearing is reported but not yet seen."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Health −2 with cited evidence"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /See how it was rated/ }),
    ).toHaveAttribute("href", `/trace/${celestun.run_id}`);
  });

  it("stays hidden for a report without a verdict or a run", () => {
    const { container } = render(
      <VerdictStrip report={{ ...report, run_id: null } as ReportOut} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
