import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TimeMachinePanel } from "@/components/time-machine/time-machine-screen";
import { WorldProvider } from "@/components/world-provider";
import type { WorldOut } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";

import { stubBrowserApis } from "../exchange/render";
import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  WORLD,
} from "../lib/helpers";
import {
  ASSETS,
  DEMO_ADMIN_WORLD,
  EVENT,
  FOREST,
  HERO,
  LIVE_ADMIN_WORLD,
  QUARTER,
  sentAlert,
  STATE,
} from "./fixtures";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(stubBrowserApis);
beforeEach(() => FakeEventSource.reset());

type Routes = Parameters<typeof fakeBackend>[0];

function renderPanel(routes: Routes = {}, world: WorldOut = DEMO_ADMIN_WORLD) {
  const backend = fakeBackend({
    "GET /world": () => json(world),
    "GET /admin/time-machine": () => json(STATE),
    "GET /assets": () => json(ASSETS),
    "GET /admin/alerts": (request) => {
      const ids = new URL(request.url).searchParams.getAll("ids");
      return json(ids.map((id) => sentAlert(id)));
    },
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
    pollIntervalMs: 60_000,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <TimeMachinePanel />
    </WorldProvider>,
  );
  return backend;
}

const conflict =
  (detail: string, status = 409) =>
  () =>
    json({ detail }, { status });

async function nextQuarterButton() {
  return screen.findByRole("button", { name: "Next quarter: Q4 2026" });
}

async function confirmQuarter() {
  fireEvent.click(await nextQuarterButton());
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Run Q4 2026" }));
}

async function confirmEvent() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Inject encroachment" }),
  );
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Inject and re-rate",
    }),
  );
}

function pending() {
  let finish: (r: Response) => void = () => {};
  const route = () => new Promise<Response>((resolve) => (finish = resolve));
  return { route, finish: (r: Response) => finish(r) };
}

async function bodyOf(request: Request | undefined) {
  return request ? ((await request.clone().json()) as unknown) : undefined;
}

describe("TimeMachinePanel", () => {
  it("shows the current quarter and the timeline", async () => {
    renderPanel();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Now: Q3 2026" }),
    ).toBeInTheDocument();
    const quarters = screen.getByRole("list", { name: "Quarters" });
    expect(within(quarters).getAllByRole("listitem")).toHaveLength(3);
    expect(within(quarters).getByText(/Simulated: encroachment/)).toBeVisible();
    expect(within(quarters).getAllByRole("listitem")[0]).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("shows a loading state, then an error with a retry", async () => {
    let fail = true;
    const backend = renderPanel({
      "GET /admin/time-machine": () =>
        fail ? json({ detail: "boom" }, { status: 500 }) : json(STATE),
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading the Time Machine…",
    );
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(
      screen.getByText("We couldn't load the Time Machine"),
    ).toBeInTheDocument();
    fail = false;
    fireEvent.click(retry);
    expect(await nextQuarterButton()).toBeEnabled();
    expect(backend.calls("GET /admin/time-machine")).toBe(2);
  });

  it("explains the live world instead of showing controls", async () => {
    renderPanel(
      {
        "GET /admin/time-machine": () =>
          json({
            ...STATE,
            available: false,
            unavailable_reason: "time_machine_sandbox_only",
          }),
      },
      LIVE_ADMIN_WORLD,
    );
    expect(
      await screen.findByText("The Time Machine runs in demo sandboxes only"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Go to the verification queue" }),
    ).toHaveAttribute("href", "/admin/verifications");
    expect(screen.getByText(/Real listings in the live world/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Next quarter/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Inject/ })).toBeNull();
  });

  it("switches to the explanation when an action is refused as sandbox-only", async () => {
    let available = true;
    renderPanel({
      "GET /admin/time-machine": () =>
        json({
          ...STATE,
          available,
          unavailable_reason: available ? null : "time_machine_sandbox_only",
        }),
      "POST /admin/simulate/quarter": () => {
        available = false;
        return json({ detail: "time_machine_sandbox_only" }, { status: 409 });
      },
    });
    await confirmQuarter();
    expect(
      await screen.findAllByText(
        "The Time Machine runs in demo sandboxes only",
      ),
    ).not.toHaveLength(0);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Next quarter/ })).toBeNull(),
    );
  });

  it("asks before running a quarter, and Cancel sends nothing", async () => {
    const backend = renderPanel({
      "POST /admin/simulate/quarter": () => json(QUARTER),
    });
    fireEvent.click(await nextQuarterButton());
    const dialog = await screen.findByRole("dialog", {
      name: "Move this sandbox to Q4 2026?",
    });
    expect(dialog).toHaveTextContent("Every listed site (2)");
    expect(dialog).toHaveTextContent("“restoration” scenario");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(backend.calls("POST /admin/simulate/quarter")).toBe(0);
  });

  it("runs the quarter with live progress, then the per-site results and alerts", async () => {
    let finish: (r: Response) => void = () => {};
    const backend = renderPanel({
      "POST /admin/simulate/quarter": () =>
        new Promise<Response>((resolve) => (finish = resolve)),
    });
    await confirmQuarter();

    expect(
      await screen.findByRole("button", { name: "Running the quarter…" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Starting the re-rates…")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances).not.toHaveLength(0));
    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("rating_progress", 1, {
        run_id: "run-1",
        asset_id: HERO,
        step: "queued",
        trigger: "time_machine",
      });
      // Another trigger's run isn't the quarter's.
      source.emit("rating_progress", 2, {
        run_id: "run-x",
        asset_id: FOREST,
        step: "queued",
        trigger: "api",
      });
      source.emit("rating_progress", 3, {
        run_id: "run-1",
        asset_id: HERO,
        step: "done",
      });
    });
    expect(
      screen.getByText(
        "Re-rating sites: 1 started, 1 done. Latest: Xochimilco Wetland.",
      ),
    ).toBeInTheDocument();

    await act(async () => finish(json(QUARTER)));
    expect(
      await bodyOf(
        backend.requests.find((r) => r.url.endsWith("/admin/simulate/quarter")),
      ),
    ).toEqual({ period: "2026Q4" });

    const result = await screen.findByRole("region", {
      name: "Quarter result",
    });
    expect(
      screen.getByText("Q4 2026: 1 done, 1 skipped.", { selector: "p" }),
    ).toHaveAttribute("role", "status");
    expect(
      within(result).getByRole("heading", {
        level: 3,
        name: "Q4 2026: restoration",
      }),
    ).toBeInTheDocument();
    const rows = within(result).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const hero = rows[1]!;
    expect(
      within(hero).getByRole("link", { name: "Xochimilco Wetland" }),
    ).toHaveAttribute("href", `/asset/${HERO}?tab=price`);
    expect(hero).toHaveTextContent("Re-rated");
    expect(within(hero).getByText("Health 76.2 to 81.3")).toBeInTheDocument();
    expect(within(hero).getByText("Grade A to AA")).toBeInTheDocument();
    expect(
      within(hero).getByText("Stake price $21.47 to $23.10"),
    ).toBeInTheDocument();
    expect(hero).toHaveTextContent("Paid");
    const forest = rows[2]!;
    expect(forest).toHaveTextContent("Skipped");
    expect(forest).toHaveTextContent("no scripted scenario for this site");
    expect(
      within(forest).getByText("Stake price $15.00 to —"),
    ).toBeInTheDocument();
    expect(within(result).getByText("Simulated · sim-1")).toBeInTheDocument();

    const phone = await within(result).findByRole("list", {
      name: "Alerts sent",
    });
    expect(phone).toHaveTextContent("Xochimilco Wetland: alert alert-1");
    expect(phone).toHaveTextContent("Sent to 3 accounts");
    expect(
      backend.requests.some((r) => r.url.includes("/admin/alerts?ids=alert-1")),
    ).toBe(true);
  });

  it.each([
    ["quarter_mismatch", "The quarter already moved"],
    ["timeline_end", "End of the scripted timeline"],
    ["local_jobs_disabled", "Time Machine jobs are off on this server"],
    [
      "time_machine_sandbox_only",
      "The Time Machine runs in demo sandboxes only",
    ],
  ])("explains a %s refusal and refreshes the state", async (code, title) => {
    const backend = renderPanel({
      "POST /admin/simulate/quarter": conflict(code),
    });
    await confirmQuarter();
    expect(await screen.findByText(title)).toBeInTheDocument();
    await waitFor(() =>
      expect(backend.calls("GET /admin/time-machine")).toBeGreaterThan(1),
    );
  });

  it("explains a rate limit with the wait", async () => {
    renderPanel({
      "POST /admin/simulate/quarter": () =>
        json(
          { detail: "rating_rate_limited" },
          { status: 429, headers: { "Retry-After": "120" } },
        ),
    });
    await confirmQuarter();
    expect(
      await screen.findByText(/Try again in 2 minutes\./),
    ).toBeInTheDocument();
  });

  it("disables Next quarter at the end of the timeline and without local jobs", async () => {
    renderPanel({
      "GET /admin/time-machine": () =>
        json({ ...STATE, next: null, local_jobs: false }),
    });
    expect(
      await screen.findByRole("button", {
        name: "End of the scripted timeline",
      }),
    ).toBeDisabled();
    expect(screen.getByText(/LOCAL_JOBS=true/)).toBeInTheDocument();
  });

  it("injects a preset into a listed site after a confirmation", async () => {
    const backend = renderPanel({
      "POST /admin/simulate/event": () => json(EVENT),
    });
    const site = await screen.findByRole("combobox", { name: "Site" });
    expect(site).toHaveTextContent("Xochimilco Wetland");
    // Only listed sites can take an event.
    fireEvent.keyDown(site, { key: "Enter" });
    expect(screen.queryByRole("option", { name: "Draft Meadow" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("option", { name: "Xochimilco Wetland" }),
    );
    expect(screen.getByRole("combobox", { name: "Event" })).toHaveTextContent(
      "Encroachment",
    );
    expect(screen.getByText("Severity 4 of 5")).toBeInTheDocument();
    expect(screen.getByText("Alerts holders as news")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Inject encroachment" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Inject encroachment at Xochimilco Wetland?",
    });
    expect(dialog).toHaveTextContent("get a news alert");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Inject and re-rate" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Encroachment at Xochimilco Wetland (simulated)",
      }),
    ).toBeInTheDocument();
    expect(
      await bodyOf(
        backend.requests.find((r) => r.url.endsWith("/admin/simulate/event")),
      ),
    ).toEqual({ asset_id: HERO, preset: "encroachment" });
    expect(screen.getByText("Grade A to BBB")).toBeInTheDocument();
    expect(screen.getByText("Health 76.2 to 65.4")).toBeInTheDocument();
    expect(
      screen.getByText("Simulated · sim-0-encroachment"),
    ).toBeInTheDocument();
    const phone = await screen.findByRole("list", { name: "Alerts sent" });
    expect(within(phone).getAllByRole("listitem")).toHaveLength(2);
  });

  it.each([
    ["stale_metrics", 409, "The site was re-rated meanwhile"],
    [
      "event_not_recorded",
      503,
      "The site was re-rated, but the event wasn't recorded",
    ],
    ["run_in_progress", 409, "A rating is already running for this site"],
    ["asset_not_listed", 409, "This site isn't listed"],
    ["llm_budget_exhausted", 503, "The AI budget is spent"],
    ["conflict_of_interest", 403, "You're in this site's community"],
  ])("explains a %s preset refusal", async (code, status, title) => {
    renderPanel({ "POST /admin/simulate/event": conflict(code, status) });
    fireEvent.click(
      await screen.findByRole("button", { name: "Inject encroachment" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Inject and re-rate",
      }),
    );
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  it("shows an early stop and an unpaid skipped site", async () => {
    renderPanel({
      "POST /admin/simulate/quarter": () =>
        json({
          ...QUARTER,
          stopped: "rating_busy",
          assets: [
            QUARTER.assets[0],
            {
              ...QUARTER.assets[1],
              status: "stopped",
              detail: "rating_busy",
              payout: null,
            },
          ],
        }),
    });
    await confirmQuarter();
    expect(
      await screen.findByText(/Stopped early: every rating worker was busy/),
    ).toBeInTheDocument();
    const forest = screen.getAllByRole("row")[2]!;
    expect(forest).toHaveTextContent("Stopped");
    expect(forest).toHaveTextContent("every rating worker was busy");
    expect(forest).toHaveTextContent("No payout");
  });

  it("says when a quarter sent no alerts", async () => {
    renderPanel({
      "POST /admin/simulate/quarter": () =>
        json({
          ...QUARTER,
          alerts: 0,
          assets: QUARTER.assets.map((a) => ({ ...a, alert_ids: [] })),
        }),
    });
    await confirmQuarter();
    expect(await screen.findByText(/No alerts were sent/)).toBeInTheDocument();
  });

  it("resets the sandbox after a confirmation", async () => {
    const backend = renderPanel({
      "POST /world/reset": () => json(DEMO_ADMIN_WORLD),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reset the demo" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Reset this sandbox?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset the demo" }),
    );
    expect(
      await screen.findByText("The sandbox is back at the start."),
    ).toBeInTheDocument();
    expect(backend.calls("POST /world/reset")).toBe(1);
  });

  it("keeps Reset focusable while it resets but won't reopen its dialog", async () => {
    const run = pending();
    const backend = renderPanel({ "POST /world/reset": run.route });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reset the demo" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Reset this sandbox?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset the demo" }),
    );
    const resetting = await screen.findByRole("button", { name: "Resetting…" });
    expect(resetting).toHaveAttribute("aria-disabled", "true");
    expect(resetting).toBeEnabled();
    fireEvent.click(resetting);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.calls("POST /world/reset")).toBe(1);
    await act(async () => run.finish(json(DEMO_ADMIN_WORLD)));
    expect(
      await screen.findByText("The sandbox is back at the start."),
    ).toBeInTheDocument();
  });

  it("never asks for the Time Machine without an admin", async () => {
    const backend = renderPanel(
      {},
      { ...WORLD, me: { ...DEMO_ADMIN_WORLD.me!, is_admin: false } },
    );
    await waitFor(() => expect(backend.calls("GET /world")).toBe(1));
    expect(backend.calls("GET /admin/time-machine")).toBe(0);
  });

  it("names the panel's sections in one outline", async () => {
    renderPanel();
    await nextQuarterButton();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Now: Q3 2026", "Inject an event", "Reset the demo"]);
  });

  it.each([
    ["rating_rate_limited", 429, "Too many ratings right now"],
    ["rating_busy", 503, "The raters are busy"],
    ["llm_budget_exhausted", 503, "The AI budget is spent"],
  ])(
    "explains a %s quarter refusal without refetching",
    async (code, status, title) => {
      const backend = renderPanel({
        "POST /admin/simulate/quarter": conflict(code, status),
      });
      await confirmQuarter();
      expect(await screen.findByText(title)).toBeInTheDocument();
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(backend.calls("GET /admin/time-machine")).toBe(1);
      expect(backend.calls("GET /assets")).toBe(1);
    },
  );

  it.each([
    ["stale_metrics", 409, true],
    ["event_not_recorded", 503, true],
    ["asset_not_listed", 409, true],
    ["run_in_progress", 409, false],
    ["no_current_metrics", 409, false],
    ["rating_busy", 503, false],
    ["conflict_of_interest", 403, false],
  ])(
    "refetches after a %s preset refusal only when the world moved",
    async (code, status, refetches) => {
      const backend = renderPanel({
        "POST /admin/simulate/event": conflict(code, status),
      });
      await confirmEvent();
      await screen.findByRole("alert");
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(backend.calls("GET /admin/time-machine") > 1).toBe(refetches);
      expect(backend.calls("GET /assets") > 1).toBe(refetches);
    },
  );

  it("counts only the runs that started, then what a replay skipped and found done", async () => {
    const run = pending();
    renderPanel({ "POST /admin/simulate/quarter": run.route });
    await confirmQuarter();
    await waitFor(() => expect(FakeEventSource.instances).not.toHaveLength(0));
    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("rating_progress", 1, {
        run_id: "run-1",
        asset_id: HERO,
        step: "queued",
        trigger: "time_machine",
      });
    });
    // Two listed sites, but only one run started: the other is skipped.
    expect(
      screen.getByText("Re-rating sites: 1 started, 0 done."),
    ).toBeInTheDocument();
    await act(async () =>
      run.finish(
        json({
          ...QUARTER,
          replayed: true,
          assets_rerated: 0,
          assets: [
            { ...QUARTER.assets[0], status: "already_done", alert_ids: [] },
            QUARTER.assets[1],
          ],
        }),
      ),
    );
    expect(
      await screen.findByText(
        "Q4 2026 (replayed): 0 done, 1 skipped, 1 already done.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Replayed: only unfinished work ran"),
    ).toBeVisible();
  });

  it("asks for more than 50 alerts in parallel batches and shows them all", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `alert-${i}`);
    const backend = renderPanel({
      "POST /admin/simulate/quarter": () =>
        json({
          ...QUARTER,
          alerts: ids.length,
          assets: [
            { ...QUARTER.assets[0], alert_ids: ids.slice(0, 40) },
            // An id listed twice is asked for once.
            { ...QUARTER.assets[1], alert_ids: [...ids.slice(40), "alert-0"] },
          ],
        }),
    });
    await confirmQuarter();
    const phone = await screen.findByRole("list", { name: "Alerts sent" });
    expect(within(phone).getAllByRole("listitem")).toHaveLength(60);
    const asked = backend.requests
      .filter((r) => new URL(r.url).pathname.endsWith("/admin/alerts"))
      .map((r) => new URL(r.url).searchParams.getAll("ids"));
    expect(asked.map((batch) => batch.length)).toEqual([50, 10]);
    expect(asked.flat()).toEqual(ids);
  });

  it("shows the phone preview's load error with a retry", async () => {
    let fail = true;
    renderPanel({
      "POST /admin/simulate/event": () => json(EVENT),
      "GET /admin/alerts": (request) =>
        fail
          ? json({ detail: "boom" }, { status: 500 })
          : json(
              new URL(request.url).searchParams
                .getAll("ids")
                .map((id) => sentAlert(id)),
            ),
    });
    await confirmEvent();
    expect(
      await screen.findByText("We couldn't load the alerts"),
    ).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const phone = await screen.findByRole("list", { name: "Alerts sent" });
    expect(within(phone).getAllByRole("listitem")).toHaveLength(2);
    // In UTC, like the price chart.
    expect(within(phone).getAllByText("10:00 UTC")).toHaveLength(2);
  });

  it("disables Reset while a quarter runs", async () => {
    const run = pending();
    renderPanel({ "POST /admin/simulate/quarter": run.route });
    const reset = await screen.findByRole("button", { name: "Reset the demo" });
    expect(reset).toBeEnabled();
    await confirmQuarter();
    await waitFor(() => expect(reset).toBeDisabled());
    expect(reset).toHaveAccessibleDescription(
      "Available once the running quarter or event finishes.",
    );
    await act(async () => run.finish(json(QUARTER)));
    await waitFor(() => expect(reset).toBeEnabled());
  });

  it("disables Reset and the pickers while an event runs, naming the requested site", async () => {
    const run = pending();
    renderPanel({ "POST /admin/simulate/event": run.route });
    const reset = await screen.findByRole("button", { name: "Reset the demo" });
    const site = await screen.findByRole("combobox", { name: "Site" });
    fireEvent.keyDown(site, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("option", { name: "Sumidero Forest" }),
    );
    await confirmEvent();
    expect(
      await screen.findByRole("button", { name: "Re-rating Sumidero Forest…" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Applying encroachment and re-rating Sumidero Forest…"),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Site" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Event" })).toBeDisabled();
    expect(reset).toBeDisabled();
    await act(async () =>
      run.finish(
        json({ ...EVENT, event: { ...EVENT.event, asset_id: FOREST } }),
      ),
    );
    await waitFor(() => expect(reset).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "Site" })).toBeEnabled();
  });

  it("keeps a running action's button focusable but won't reopen its dialog", async () => {
    const quarterRun = pending();
    const eventRun = pending();
    renderPanel({
      "POST /admin/simulate/quarter": quarterRun.route,
      "POST /admin/simulate/event": eventRun.route,
    });
    await confirmQuarter();
    const quarter = await screen.findByRole("button", {
      name: "Running the quarter…",
    });
    expect(quarter).toBeEnabled();
    fireEvent.click(quarter);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => quarterRun.finish(json(QUARTER)));

    await confirmEvent();
    const inject = await screen.findByRole("button", {
      name: /^Re-rating /,
    });
    expect(inject).toBeEnabled();
    fireEvent.click(inject);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => eventRun.finish(json(EVENT)));
  });

  it("announces what an injected event did once it finishes", async () => {
    renderPanel({ "POST /admin/simulate/event": () => json(EVENT) });
    await confirmEvent();
    const status = await screen.findByText(/: health .* to .*, grade /, {
      selector: "[role=status] span",
    });
    expect(status.textContent).toMatch(/stake price \$/);
  });

  it("tells a signed-in non-admin the panel is for admins", async () => {
    renderPanel(
      {},
      { ...WORLD, me: { ...DEMO_ADMIN_WORLD.me!, is_admin: false } },
    );
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(
      screen.getByText(/Only a platform admin can run the Time Machine/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Next quarter/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
  });
});
