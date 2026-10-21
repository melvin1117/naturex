import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceSheet } from "@/components/proto/trace-sheet";
import { usePrototype } from "@/lib/prototype/store";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { cards } from "../trade/fixtures";
import {
  FakeEventSource,
  json,
  sequence,
  SIGNED_IN_WORLD,
} from "../lib/helpers";
import {
  ASSET_ID,
  OLD_RUN_ID,
  REPORT,
  report,
  RUN_ID,
  runTrace,
} from "./fixtures";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(stubBrowserApis);
beforeEach(() => {
  FakeEventSource.reset();
  nav.pathname = `/asset/${ASSET_ID}`;
});

function Opener() {
  const { openTrace } = usePrototype();
  return (
    <>
      <button type="button" onClick={() => openTrace()}>
        Open trace
      </button>
      <button type="button" onClick={() => openTrace(RUN_ID)}>
        Open latest run
      </button>
    </>
  );
}

type Routes = Parameters<typeof renderExchange>[1];

function renderSheet(routes: Routes = {}) {
  return renderExchange(
    <>
      <Opener />
      <TraceSheet />
    </>,
    {
      [`GET /assets/${ASSET_ID}`]: () =>
        json({ ...REPORT, id: ASSET_ID, latest_run_id: null }),
      [`GET /assets/${ASSET_ID}/reports`]: () =>
        json([report(2, RUN_ID), report(1, OLD_RUN_ID)]),
      [`GET /runs/${RUN_ID}/trace`]: () => json(runTrace()),
      [`GET /runs/${OLD_RUN_ID}/trace`]: () =>
        json(runTrace({ run_id: OLD_RUN_ID, steps: [] })),
      ...routes,
    },
  );
}

async function sheet() {
  return screen.findByRole("dialog", { name: "Agent Trace" });
}

describe("TraceSheet on a real site", () => {
  it("lists each step of the run with model, tokens, latency and output", async () => {
    const { backend } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Open latest run" }));

    const steps = await within(await sheet()).findByRole("list", {
      name: "Run steps",
    });
    const items = within(steps).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[2]).toHaveTextContent("Read satellite metrics");
    expect(items[2]).toHaveTextContent("Nemotron 3 Super");
    expect(items[2]).toHaveTextContent("1,840 in · 310 out");
    expect(items[2]).toHaveTextContent("0.42 s");
    expect(items[3]).toHaveTextContent("Failed");
    expect(screen.getByText("Model calls").nextSibling).toHaveTextContent("4");
    expect(screen.getByText("Tokens").nextSibling).toHaveTextContent("12,870");
    expect(items[5]).toHaveTextContent("Seal the report");
    expect(items[5]).toHaveTextContent("500 in · 20 out");
    expect(screen.getByText("Time").nextSibling).toHaveTextContent("20.0 s");
    expect(screen.queryByText(/Prototype replay/)).not.toBeInTheDocument();

    const earth = within(items[2]!).getByRole("button");
    expect(earth).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(earth);
    expect(earth).toHaveAttribute("aria-expanded", "true");
    expect(
      within(items[2]!).getByText(/"data_version": "2026Q3"/),
    ).toBeVisible();
    expect(within(items[2]!).getByText("Model attempts")).toBeVisible();

    fireEvent.click(within(items[3]!).getByRole("button"));
    expect(
      within(items[3]!).getByText("Error: tavily_unavailable"),
    ).toBeVisible();
    expect(backend.calls(`GET /runs/${RUN_ID}/trace`)).toBe(1);
  });

  it("opens on the newest run and switches between runs", async () => {
    const { backend } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));

    await within(await sheet()).findByRole("list", { name: "Run steps" });
    expect(backend.calls(`GET /runs/${RUN_ID}/trace`)).toBe(1);

    const picker = screen.getByRole("combobox", { name: "Rating run" });
    expect(picker).toHaveTextContent("Report v2");
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: /Report v1/ }));

    expect(
      await screen.findByText("This run hasn't recorded any steps yet."),
    ).toBeInTheDocument();
    expect(backend.calls(`GET /runs/${OLD_RUN_ID}/trace`)).toBe(1);
  });

  it("shows a loading state", async () => {
    renderSheet({
      [`GET /runs/${RUN_ID}/trace`]: () => new Promise<Response>(() => {}),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open latest run" }));

    expect(await screen.findByText("Loading the trace…")).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    renderSheet({
      [`GET /runs/${RUN_ID}/trace`]: sequence(
        () => json({ detail: "boom" }, { status: 500 }),
        () => json(runTrace()),
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open latest run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't load the trace",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("list", { name: "Run steps" }),
    ).toBeInTheDocument();
  });

  it("says when a run's trace is gone, without a retry", async () => {
    renderSheet({
      [`GET /runs/${RUN_ID}/trace`]: () =>
        json({ detail: "Not Found" }, { status: 404 }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open latest run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This rating run's trace isn't available",
    );
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("waits for the site as well as its reports before choosing a run", async () => {
    const LATEST = "66666666-6666-4666-8666-666666666602";
    let answer: (response: Response) => void = () => {};
    const { backend } = renderSheet({
      [`GET /assets/${ASSET_ID}`]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
      [`GET /runs/${LATEST}/trace`]: () => json(runTrace({ run_id: LATEST })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));
    await waitFor(() =>
      expect(backend.calls(`GET /assets/${ASSET_ID}/reports`)).toBe(1),
    );

    expect(await screen.findByText("Loading rating runs…")).toBeInTheDocument();
    expect(
      screen.queryByText(/No rating run has been recorded/),
    ).not.toBeInTheDocument();
    expect(backend.calls(`GET /runs/${RUN_ID}/trace`)).toBe(0);

    // The listing's run under review comes first, so it is the one shown.
    act(() => answer(json({ ...REPORT, id: ASSET_ID, latest_run_id: LATEST })));
    expect(
      await screen.findByRole("list", { name: "Run steps" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Rating run" }),
    ).toHaveTextContent("Latest run");
    expect(backend.calls(`GET /runs/${LATEST}/trace`)).toBe(1);
    expect(backend.calls(`GET /runs/${RUN_ID}/trace`)).toBe(0);
  });

  it("explains a site with only seeded reports", async () => {
    const { backend } = renderSheet({
      [`GET /assets/${ASSET_ID}/reports`]: () => json([report(1, null)]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));

    expect(
      await screen.findByText(/No rating run has been recorded for this site/),
    ).toBeInTheDocument();
    expect(backend.calls(`GET /runs/${RUN_ID}/trace`)).toBe(0);
  });

  it("refetches an active run on its progress events", async () => {
    let status: "running" | "succeeded" = "running";
    renderSheet({
      [`GET /runs/${RUN_ID}/trace`]: () => json(runTrace({ status })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open latest run" }));
    expect(await screen.findByText(/, running\./)).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances).not.toHaveLength(0));

    status = "succeeded";
    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("rating_progress", 3, {
        run_id: RUN_ID,
        asset_id: ASSET_ID,
        step: "done",
        status: "succeeded",
      });
    });
    expect(await screen.findByText(/, succeeded\./)).toBeInTheDocument();
  });
});

describe("TraceSheet away from a real site", () => {
  it("shows a signed-in account the world's latest model calls", async () => {
    nav.pathname = "/portfolio";
    renderSheet({
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /admin/trace": () =>
        json({
          asset_id: null,
          steps: [
            {
              agent: "auditor",
              model: "nvidia/Nemotron-3-Ultra-550b-a55b",
              prompt_tokens: 6200,
              completion_tokens: 980,
              latency_ms: 6800,
              created_at: "2026-10-19T08:00:16Z",
              status: "ok",
            },
          ],
        }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));

    const calls = await within(await sheet()).findByRole("list", {
      name: "Latest model calls",
    });
    expect(calls).toHaveTextContent("auditor");
    expect(calls).toHaveTextContent("Nemotron 3 Ultra");
    expect(calls).toHaveTextContent("6,200 in · 980 out");
    expect(
      screen.getByRole("tab", { name: "Model calls" }),
    ).toBeInTheDocument();
  });

  it("says when no model call has been logged yet", async () => {
    nav.pathname = "/portfolio";
    renderSheet({
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /admin/trace": () => json({ asset_id: null, steps: [] }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));

    const panel = await sheet();
    expect(
      await within(panel).findByText("No model calls logged in this world yet"),
    ).toBeInTheDocument();
    // It teaches: what appears, why it may be empty and where to look instead.
    expect(panel).toHaveTextContent("Live ratings log their model calls here");
    expect(panel).toHaveTextContent("Mock ratings don't call a model");
    expect(panel).toHaveTextContent("Open a site and choose How it was rated");
    expect(
      within(panel).queryByRole("list", { name: "Latest model calls" }),
    ).toBeNull();
    // No curated site in this world: no link to one.
    expect(within(panel).queryByRole("link", { name: /was rated/ })).toBeNull();
  });

  it("links an empty trace to a curated site's rating runs", async () => {
    nav.pathname = "/portfolio";
    renderSheet({
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /admin/trace": () => json({ asset_id: null, steps: [] }),
      "GET /assets": () => json(cards),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));

    const link = await within(await sheet()).findByRole("link", {
      name: `See how ${cards[0]!.name} was rated`,
    });
    expect(link).toHaveAttribute("href", `/asset/${cards[0]!.id}`);
  });

  it("shows an error with a retry for the world's model calls", async () => {
    nav.pathname = "/portfolio";
    const { backend } = renderSheet({
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /admin/trace": sequence(
        () => json({ detail: "boom" }, { status: 500 }),
        () => json({ asset_id: null, steps: [] }),
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));

    expect(await within(await sheet()).findByRole("alert")).toHaveTextContent(
      "We couldn't load the model calls",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("No model calls logged in this world yet"),
    ).toBeInTheDocument();
    expect(backend.calls("GET /admin/trace")).toBe(2);
  });

  it("keeps the anonymous prototype's recorded runs", async () => {
    nav.pathname = "/";
    const { backend } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Open trace" }));

    expect(
      await within(await sheet()).findByText(/Prototype replay/),
    ).toBeInTheDocument();
    expect(backend.calls("GET /admin/trace")).toBe(0);
    expect(backend.calls(`GET /runs/${RUN_ID}/trace`)).toBe(0);
  });
});
