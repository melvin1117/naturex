import {
  act,
  configure,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { TimeMachinePanel } from "@/components/time-machine/time-machine-screen";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";

import { stubBrowserApis } from "../exchange/render";
import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
} from "../lib/helpers";
import {
  ASSETS,
  DEMO_ADMIN_WORLD,
  JOB_ID,
  QUARTER,
  quarterJob,
  sentAlert,
  STATE,
} from "./fixtures";

// Poll every 20 ms instead of 2 s, so these tests watch several polls go by.
vi.mock("@/lib/time-machine", async (original) => ({
  ...(await original<typeof import("@/lib/time-machine")>()),
  QUARTER_POLL_MS: 20,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  stubBrowserApis();
  // A loaded CI machine can take more than a second to render the panel.
  configure({ asyncUtilTimeout: 5_000 });
});
beforeEach(() => FakeEventSource.reset());
afterEach(() => setHidden(false));

const JOB_ROUTE = `GET /admin/simulate/quarter/${JOB_ID}`;
const RUNNING = quarterJob(QUARTER, { status: "running", finished_at: null });
const WITH_JOB = {
  ...STATE,
  quarter_job: { id: JOB_ID, status: "running", period: "2026Q4" },
};

type Handler = Parameters<typeof fakeBackend>[0][string];

function renderPanel(job: Handler, state: Handler = () => json(WITH_JOB)) {
  const backend = fakeBackend({
    "GET /world": () => json(DEMO_ADMIN_WORLD),
    "GET /admin/time-machine": state,
    "GET /assets": () => json(ASSETS),
    "GET /admin/alerts": (request) =>
      json(
        new URL(request.url).searchParams
          .getAll("ids")
          .map((id) => sentAlert(id)),
      ),
    [JOB_ROUTE]: job,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
    pollIntervalMs: 60_000,
  });
  const view = render(
    <WorldProvider dataLayer={layer}>
      <TimeMachinePanel />
    </WorldProvider>,
  );
  return { backend, ...view };
}

const pause = (ms = 150) =>
  act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("polling a quarter job (#201)", () => {
  it("polls a running job until it settles, then stops", async () => {
    const { backend } = renderPanel(
      sequence(
        () => json(RUNNING),
        () => json(RUNNING),
        () => json(quarterJob()),
      ),
    );
    await screen.findByText("Q4 2026: 1 done, 1 skipped.", { selector: "p" });
    const calls = backend.calls(JOB_ROUTE);
    expect(calls).toBe(3);
    await pause();
    expect(backend.calls(JOB_ROUTE)).toBe(calls);
  });

  it("stops after a 404, forgets the job and rereads where the sandbox stands", async () => {
    let reset = false;
    const { backend } = renderPanel(
      sequence(
        () => json(RUNNING),
        () => {
          reset = true;
          return json({ detail: "not_found" }, { status: 404 });
        },
      ),
      () => json(reset ? STATE : WITH_JOB),
    );
    await waitFor(() => expect(backend.calls(JOB_ROUTE)).toBe(2));
    await waitFor(() =>
      expect(backend.calls("GET /admin/time-machine")).toBeGreaterThan(1),
    );
    await pause();
    expect(backend.calls(JOB_ROUTE)).toBe(2);
    expect(
      await screen.findByRole("button", { name: "Next quarter: Q4 2026" }),
    ).not.toHaveAttribute("aria-disabled");
    expect(
      screen.getByRole("button", { name: "Reset the demo" }),
    ).toBeEnabled();
    expect(screen.queryByText("We couldn't check the quarter")).toBeNull();
  });

  it("stops after a 401 and never holds Reset", async () => {
    const { backend } = renderPanel(
      sequence(
        () => json(RUNNING),
        () => json({ detail: "auth_required" }, { status: 401 }),
      ),
    );
    expect(
      await screen.findByText("We couldn't check the quarter"),
    ).toBeInTheDocument();
    // The client retries a session-ended 401 once (after a fresh bootstrap); then no polls.
    const calls = backend.calls(JOB_ROUTE);
    expect(calls).toBeLessThanOrEqual(3);
    await pause();
    expect(backend.calls(JOB_ROUTE)).toBe(calls);
    expect(
      screen.getByRole("button", { name: "Reset the demo" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Running the quarter…" }),
    ).toBeNull();
  });

  it("pauses while the tab is hidden and reads again when it's back", async () => {
    const { backend } = renderPanel(() => json(RUNNING));
    await waitFor(() => expect(backend.calls(JOB_ROUTE)).toBeGreaterThan(1));
    act(() => setHidden(true));
    await pause(50);
    const hidden = backend.calls(JOB_ROUTE);
    await pause();
    expect(backend.calls(JOB_ROUTE)).toBe(hidden);

    act(() => setHidden(false));

    await waitFor(() =>
      expect(backend.calls(JOB_ROUTE)).toBeGreaterThan(hidden),
    );
  });

  it("stops when the panel unmounts", async () => {
    const { backend, unmount } = renderPanel(() => json(RUNNING));
    await waitFor(() => expect(backend.calls(JOB_ROUTE)).toBeGreaterThan(1));

    unmount();
    const calls = backend.calls(JOB_ROUTE);
    await pause();

    expect(backend.calls(JOB_ROUTE)).toBe(calls);
  });

  it("doesn't show the quarter running while its job is still loading", async () => {
    renderPanel(() => new Promise<Response>(() => {}));
    expect(
      await screen.findByRole("button", { name: "Next quarter: Q4 2026" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Running the quarter…" }),
    ).toBeNull();
  });

  it("opening on a finished job refetches nothing else", async () => {
    const { backend } = renderPanel(
      () => json(quarterJob()),
      () =>
        json({
          ...STATE,
          quarter_job: { id: JOB_ID, status: "done", period: "2026Q4" },
        }),
    );
    await screen.findByRole("region", { name: "Quarter result" });
    await pause();
    expect(backend.calls("GET /admin/time-machine")).toBe(1);
    expect(backend.calls("GET /assets")).toBe(1);
  });
});
