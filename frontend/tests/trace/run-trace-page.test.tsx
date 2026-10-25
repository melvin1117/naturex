import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  RecordedTracePage,
  RunTracePage,
} from "@/components/trace/run-trace-page";
import { EvalResults } from "@/components/trace/eval-results";
import { VerdictStrip } from "@/components/trace/verdict-strip";
import type { RecordedRun, ReportOut } from "@/lib/api/types";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { json, WORLD } from "../lib/helpers";
import celestun from "./fixtures/run-celestun.json";
import recorded from "./fixtures/recorded-mangrove.json";

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

describe("a demo site's recorded run", () => {
  const recordedRun = recorded as unknown as RecordedRun;
  const assetId = "a5e7a5e7-0000-4000-8000-000000000001";

  it("stands in for a missing run on the site, labelled with its date", () => {
    render(
      <VerdictStrip
        report={{ run_id: null, auditor: null } as unknown as ReportOut}
        recorded={recordedRun}
        assetId={assetId}
      />,
    );

    expect(
      screen.getByText(
        /^Multiple encroachment events and a June 2025 greenness dip/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /A recorded run, .*2026 · Health −2 with cited evidence/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /See how it was rated/ }),
    ).toHaveAttribute("href", `/trace/recorded/${assetId}`);
  });

  it("stays out of a site that has a run of its own, even without a verdict", () => {
    const { container } = render(
      <VerdictStrip
        report={
          { run_id: celestun.run_id, auditor: null } as unknown as ReportOut
        }
        recorded={recordedRun}
        assetId={assetId}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("points to the site's own run once it has been rated", async () => {
    renderExchange(<RecordedTracePage assetId={assetId} />, {
      [`GET /assets/${assetId}`]: () =>
        json({
          id: assetId,
          name: "Ría Celestún Mangrove",
          site_key: "mangrove_mx",
          latest_report: { run_id: celestun.run_id },
        }),
      "GET /media/demo-sites/mangrove_mx/recorded-run.json": () =>
        json(recorded),
    });

    expect(
      await screen.findByRole("link", { name: "Open that run's trace" }),
    ).toHaveAttribute("href", `/trace/${celestun.run_id}`);
  });

  it("never replaces the site's own rated run", () => {
    render(
      <VerdictStrip
        report={
          {
            run_id: celestun.run_id,
            auditor: {
              verdict: "Own verdict [metric:x].",
              auditor_adjustment: 0,
            },
          } as unknown as ReportOut
        }
        recorded={recordedRun}
        assetId={assetId}
      />,
    );
    expect(screen.getByText("Own verdict.")).toBeInTheDocument();
    expect(screen.queryByText(/A recorded run/)).not.toBeInTheDocument();
  });

  it("opens as a full trace on the site, marked Recorded", async () => {
    renderExchange(<RecordedTracePage assetId={assetId} />, {
      [`GET /assets/${assetId}`]: () =>
        json({
          id: assetId,
          name: "Ría Celestún Mangrove",
          site_key: "mangrove_mx",
        }),
      "GET /media/demo-sites/mangrove_mx/recorded-run.json": () =>
        json(recorded),
    });

    expect(
      await screen.findByRole("heading", {
        name: "How Ría Celestún Mangrove was rated",
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/^Recorded /)).toBeInTheDocument();
    expect(
      screen.getByText(/A real rating run of this site, recorded on/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Ría Celestún Mangrove" }),
    ).toHaveAttribute("href", `/asset/${assetId}`);
    const story = screen.getByRole("list", {
      name: "What happened in this run",
    });
    expect(within(story).getByText(/followed up/)).toBeVisible();
  });
});

describe("in a no-sign-up demo session", () => {
  const demoWorld = {
    ...WORLD,
    label: "visitor",
    me: {
      id: "55555555-5555-4555-8555-555555555555",
      name: "Rosa",
      email: null,
      kind: "persona" as const,
      is_admin: false,
      world_id: WORLD.id,
      persona: "rosa" as const,
    },
  };

  it("tells the run without a single price", async () => {
    const { layer } = renderExchange(<RunTracePage runId={celestun.run_id} />, {
      "GET /world": () => json(demoWorld),
      [`GET /runs/${celestun.run_id}/trace`]: () => json(celestun),
      [`GET /assets/${celestun.asset_id}`]: () =>
        json({ id: celestun.asset_id, name: "Ría Celestún Mangrove" }),
    });
    await screen.findByRole("heading", {
      name: "How Ría Celestún Mangrove was rated",
    });
    await waitFor(() =>
      expect(layer.session.getSnapshot().world?.me?.persona).toBe("rosa"),
    );

    expect(screen.getByText(/6 model calls · 4 web searches/)).toBeVisible();
    expect(screen.queryByText(/less than Ultra/)).toBeNull();
    expect(screen.queryByRole("tab", { name: "Cost" })).toBeNull();
    const story = screen.getByRole("list", {
      name: "What happened in this run",
    });
    expect(within(story).getByText(/sealed in the Record/)).toBeVisible();
    // Model spend is gone; the land's own ecosystem value ($…M a year) stays.
    expect(story.textContent).not.toMatch(/in model calls|less than running/);
  });

  it("publishes the evals without prices", async () => {
    const demo = renderExchange(<EvalResults />, {
      "GET /world": () => json(demoWorld),
    });
    await waitFor(() =>
      expect(demo.layer.session.getSnapshot().world?.me).not.toBeNull(),
    );
    expect(screen.queryByText("Cost per audit")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /^Cost/ })).toBeNull();
    demo.unmount();

    const signedOut = renderExchange(<EvalResults />);
    await waitFor(() =>
      expect(signedOut.layer.session.getSnapshot().world).not.toBeNull(),
    );
    expect(screen.getByText("Cost per audit")).toBeVisible();
  });
});
