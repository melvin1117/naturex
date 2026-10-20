import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ListingScreen } from "@/components/listing/listing-screen";
import { StewardCommunityProvider } from "@/components/shell/steward-community";
import { WorldProvider } from "@/components/world-provider";
import type { AssetDetail, RatingRun, ReportOut } from "@/lib/api/types";
import { listingAction } from "@/lib/community";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  BASE,
  community,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  SIGNED_IN_WORLD,
} from "../lib/helpers";

const nav = vi.hoisted(() => ({ search: "" }));
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/steward/list",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// Leaflet doesn't run in jsdom: a stand-in map adds the corners of a ~123 ha square.
const CORNERS = vi.hoisted(
  () =>
    [
      [0, 0],
      [0, 0.01],
      [0.01, 0.01],
      [0.01, 0],
    ] as [number, number][],
);
vi.mock("@/components/proto/draw-map", () => ({
  DrawMap: ({
    points,
    onAdd,
  }: {
    points: [number, number][];
    onAdd: (p: [number, number]) => void;
  }) => (
    <button type="button" onClick={() => onAdd(CORNERS[points.length % 4])}>
      Add test corner
    </button>
  ),
}));

beforeAll(() => {
  // jsdom lacks these; Radix dialogs and checkboxes ask for them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.reset();
  nav.search = `community=${SELVA.id}`;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const SELVA = community();
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "88888888-8888-4888-8888-888888888888";
const ASSET = `GET /assets/${ASSET_ID}`;

const RING = [
  [0, 0],
  [0.01, 0],
  [0.01, 0.01],
  [0, 0.01],
  [0, 0],
];

function asset(overrides: Partial<AssetDetail> = {}): AssetDetail {
  return {
    id: ASSET_ID,
    name: "Laguna Verde",
    country: "MX",
    description: null,
    community_id: SELVA.id,
    status: "draft",
    status_reason: null,
    area_ha: "123.21",
    geojson: { type: "Polygon", coordinates: [RING] },
    primary_shares_remaining: 0,
    community_wallet: "0.00",
    mock: false,
    latest_report: null,
    recent_events: [],
    trading: false,
    ...overrides,
  } as AssetDetail;
}

const REPORT = {
  id: "99999999-9999-4999-8999-999999999999",
  asset_id: ASSET_ID,
  version: 1,
  grade: "AA",
  health_score: "85.10",
  confidence: "71.00",
  value_low: "1700000",
  value_mid: "2700000",
  value_high: "2700000",
  summary_source: "fallback",
  simulated: false,
  created_at: "2026-10-19T00:00:00Z",
} as unknown as ReportOut;

function ratingRun(overrides: Partial<RatingRun> = {}): RatingRun {
  return {
    run_id: RUN_ID,
    asset_id: ASSET_ID,
    status: "queued",
    degraded: false,
    reasons: [],
    steps: [
      {
        step: "queued",
        status: "queued",
        prompt_tokens: 0,
        completion_tokens: 0,
      },
    ],
    ...overrides,
  };
}

const step = (name: string, status: string, extra: object = {}) => ({
  step: name,
  status,
  prompt_tokens: 0,
  completion_tokens: 0,
  ...extra,
});

const OUTLINES = { outlines: [], truncated: false };

type Routes = Parameters<typeof fakeBackend>[0];

function setup(routes: Routes = {}) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    "GET /me/communities": () => json([SELVA]),
    "GET /assets/outlines": () => json(OUTLINES),
    [`GET /runs/${RUN_ID}`]: () => json(ratingRun()),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <StewardCommunityProvider>
          <ListingScreen />
        </StewardCommunityProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
  return backend;
}

async function bodyOf(backend: ReturnType<typeof setup>, route: string) {
  const [method, path] = route.split(" ");
  const request = backend.requests.find(
    (r) => r.method === method && new URL(r.url).pathname.endsWith(path),
  );
  return request ? ((await request.clone().json()) as unknown) : undefined;
}

/** The real form (not the prototype's, shown until `GET /world` answers). */
const realForm = () => screen.findByText(/Listed for this community/);

async function fillDetails() {
  await realForm();
  fireEvent.change(screen.getByLabelText("Site name"), {
    target: { value: "Laguna Verde" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /Continue to boundary/ }));
}

async function drawSquare() {
  const add = await screen.findByRole("button", { name: "Add test corner" });
  for (let i = 0; i < 4; i++) fireEvent.click(add);
}

const problem = (type: string, msg: string) => ({
  type: `polygon.${type}`,
  loc: ["body", "geojson"],
  msg,
});

describe("creating a listing", () => {
  it("hints, draws, saves the draft and lands on its review", async () => {
    const backend = setup({
      "POST /assets": () => json(asset(), { status: 201 }),
      [ASSET]: () => json(asset()),
    });
    await realForm();
    fireEvent.click(
      screen.getByRole("button", { name: /Continue to boundary/ }),
    );
    expect(await screen.findByText("Use 2–80 characters.")).toBeVisible();
    expect(
      screen.getByText("Confirm your community may list this land."),
    ).toBeVisible();
    expect(screen.getByLabelText("Community")).toHaveValue("Selva Viva");

    await fillDetails();
    await drawSquare();
    expect(screen.getByText("4 corners")).toBeVisible();
    expect(
      screen.getByText(/Shape, size and overlap look right/),
    ).toBeVisible();
    expect(screen.getByText(/^12\d ha$/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));
    expect(await screen.findByText("Ready to rate")).toBeVisible();
    expect(await bodyOf(backend, "POST /assets")).toEqual({
      community_id: SELVA.id,
      name: "Laguna Verde",
      country: "MX",
      description: null,
      geojson: { type: "Polygon", coordinates: [RING] },
      attestation: true,
    });
    expect(router.replace).toHaveBeenCalledWith(
      `/steward/list?community=${SELVA.id}&asset=${ASSET_ID}`,
      { scroll: false },
    );
  });

  it("shows the server's 422 polygon problems, one per issue", async () => {
    setup({
      "POST /assets": () =>
        json(
          {
            detail: [
              problem("too_small", "The area is 3.3 ha; the minimum is 10 ha."),
              problem("overlap", "This area overlaps another listing."),
            ],
          },
          { status: 422 },
        ),
    });
    await fillDetails();
    await drawSquare();
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("NatureX couldn't accept this boundary");
    const items = within(alert).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Too small. The area is 3.3 ha; the minimum is 10 ha.",
      "Overlap. This area overlaps another listing.",
    ]);
  });

  it("422 field errors send the steward back to the details", async () => {
    setup({
      "POST /assets": () =>
        json(
          {
            detail: [
              {
                type: "value_error",
                loc: ["body", "name"],
                msg: "Value error, Use letters, digits, spaces and - ' . , & ( ) only",
              },
            ],
          },
          { status: 422 },
        ),
    });
    await fillDetails();
    await drawSquare();
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));
    expect(
      await screen.findByText(
        "Use letters, digits, spaces and - ' . , & ( ) only",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Site name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("409 listing_limit_reached links to the community home", async () => {
    setup({
      "POST /assets": () =>
        json({ detail: "listing_limit_reached" }, { status: 409 }),
    });
    await fillDetails();
    await drawSquare();
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many listings in progress");
    expect(
      within(alert).getByRole("link", { name: "Community home" }),
    ).toHaveAttribute("href", `/steward?community=${SELVA.id}`);
  });
});

describe("rating progress", () => {
  it("submits, lights each step from rating_progress and ends listed", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    let current = asset();
    let run = ratingRun();
    const backend = setup({
      [ASSET]: () => json(current),
      [`GET /runs/${RUN_ID}`]: () => json(run),
      [`POST /assets/${ASSET_ID}/submit`]: () => {
        current = asset({ status: "rating", latest_run_id: RUN_ID });
        return json(
          { asset_id: ASSET_ID, run_id: RUN_ID, status: "rating" },
          { status: 202 },
        );
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /Rate this site/ }),
    );
    expect(await screen.findByText("Rating in progress")).toBeVisible();
    expect(backend.calls(`POST /assets/${ASSET_ID}/submit`)).toBe(1);

    const row = (label: string) =>
      screen.getByText(label, { selector: "span" }).closest("li")!;
    await waitFor(() => expect(row("Queued")).toHaveTextContent("running"));

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const stream = FakeEventSource.latest();
    // The run as GET /runs/{id} rebuilds it; each event only triggers a refetch.
    run = ratingRun({
      status: "running",
      steps: [
        step("queued", "queued"),
        step("started", "running"),
        step("earth_obs", "ok", { latency_ms: 1500 }),
        step("valuation", "ok", { latency_ms: 30, model: "nvidia/nemotron" }),
      ],
    });
    act(() => {
      stream.open();
      const emit = (id: number, payload: Record<string, unknown>) =>
        stream.emit("rating_progress", id, {
          run_id: RUN_ID,
          asset_id: ASSET_ID,
          ...payload,
        });
      emit(1, { step: "started", status: "running" });
      emit(2, { step: "earth_obs", status: "ok", latency_ms: 1500 });
      emit(3, {
        step: "valuation",
        status: "ok",
        latency_ms: 30,
        model: "nvidia/nemotron",
      });
    });
    await waitFor(() =>
      expect(row("Satellite data")).toHaveTextContent("done"),
    );
    expect(row("Satellite data")).toHaveTextContent("1.5 s");
    expect(row("Valuation")).toHaveTextContent("nvidia/nemotron");
    expect(row("Local news")).toHaveTextContent("running");
    expect(row("Sealed report")).toHaveTextContent("waiting");

    current = asset({
      status: "listed",
      mock: true,
      latest_report: REPORT,
    });
    run = ratingRun({
      status: "succeeded",
      steps: [...(run.steps ?? []), step("done", "succeeded")],
    });
    act(() => {
      stream.emit("rating_progress", 4, {
        run_id: RUN_ID,
        asset_id: ASSET_ID,
        step: "done",
        status: "succeeded",
        listing_status: "listed",
      });
    });
    const offer = await screen.findByRole("link", {
      name: /Set up the opening offer/,
    });
    expect(offer).toHaveAttribute(
      "href",
      `/steward/assets/${ASSET_ID}/ipo?community=${SELVA.id}`,
    );
    expect(screen.getByText("Laguna Verde is listed")).toBeVisible();
    expect(screen.getByText("Mock data")).toBeVisible();
    expect(screen.getByText(/placeholder metrics/)).toBeVisible();
  });

  it("resumes a listing waiting for satellite data, and says why a retry is refused", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    setup({
      [ASSET]: () =>
        json(
          asset({
            status: "rating",
            status_reason: "no_satellite_metrics",
            latest_run_id: RUN_ID,
          }),
        ),
      [`GET /runs/${RUN_ID}`]: () =>
        json(
          ratingRun({
            status: "failed",
            error: "earth_obs_failed:no_cached_metrics",
            steps: [
              {
                step: "queued",
                status: "queued",
                prompt_tokens: 0,
                completion_tokens: 0,
              },
              {
                step: "earth_obs",
                status: "failed",
                error: "no_cached_metrics",
                prompt_tokens: 0,
                completion_tokens: 0,
              },
              {
                step: "done",
                status: "failed",
                error: "earth_obs_failed:no_cached_metrics",
                prompt_tokens: 0,
                completion_tokens: 0,
              },
            ],
          }),
        ),
      [`POST /assets/${ASSET_ID}/submit`]: () =>
        json({ detail: "metrics_unavailable" }, { status: 409 }),
    });
    expect(
      await screen.findByRole("heading", {
        name: "Waiting for satellite data",
      }),
    ).toBeVisible();
    expect(screen.getByText(/Try again later/)).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByText("Satellite data", { selector: "span" }).closest("li"),
      ).toHaveTextContent("failed"),
    );
    expect(screen.getByText("The rating stopped.")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: /Try the rating again/ }),
    );
    expect(await screen.findByText("Still no satellite data")).toBeVisible();
  });

  it("a stale run can be retried; 429 resubmit_cooldown shows the wait", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    setup({
      [ASSET]: () =>
        json(
          asset({
            status: "rating",
            status_reason: "rating_stale",
            latest_run_id: RUN_ID,
          }),
        ),
      [`GET /runs/${RUN_ID}`]: () =>
        json(ratingRun({ status: "failed", error: "stale" })),
      [`POST /assets/${ASSET_ID}/submit`]: () =>
        json(
          { detail: "resubmit_cooldown" },
          { status: 429, headers: { "Retry-After": "540" } },
        ),
    });
    expect(
      await screen.findByRole("heading", { name: "The rating stopped" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByText(/Stopped with/)).toHaveTextContent("stale"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Try the rating again/ }),
    );
    expect(
      await screen.findByText(/You can submit it again in 9 minutes/),
    ).toBeVisible();
  });

  it("flags a run the fixed pipeline finished (fallback, degraded)", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    setup({
      [ASSET]: () =>
        json(
          asset({
            status: "needs_evidence",
            status_reason: "confidence_below_70",
            latest_report: { ...REPORT, grade: "BB", confidence: "55.00" },
            latest_run_id: RUN_ID,
          }),
        ),
      [`GET /runs/${RUN_ID}`]: () =>
        json(
          ratingRun({
            status: "degraded",
            degraded: true,
            reasons: ["orchestrator_fallback"],
            steps: [
              {
                step: "fallback",
                status: "ok",
                prompt_tokens: 0,
                completion_tokens: 0,
              },
              {
                step: "done",
                status: "degraded",
                prompt_tokens: 0,
                completion_tokens: 0,
              },
            ],
          }),
        ),
    });
    expect(
      await screen.findByText(/fixed pipeline took over/),
    ).toHaveTextContent("orchestrator_fallback");
    expect(screen.getByText("Rating finished with a fallback.")).toBeVisible();
  });
});

describe("outcomes", () => {
  it("needs_evidence explains, and revise reopens the boundary", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    const backend = setup({
      [ASSET]: () =>
        json(
          asset({
            status: "needs_evidence",
            status_reason: "confidence_below_70",
            latest_report: { ...REPORT, grade: "BB", confidence: "55.00" },
          }),
        ),
      [`POST /assets/${ASSET_ID}/revise`]: () => json(asset()),
    });
    expect(
      await screen.findByRole("heading", { name: "Needs more evidence" }),
    ).toBeVisible();
    expect(screen.getByText(/at least 70% confident/)).toBeVisible();
    expect(screen.getByText("55% confidence")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Revise the listing/ }));
    expect(
      await screen.findByRole("heading", { name: "Draw the boundary" }),
    ).toBeVisible();
    expect(backend.calls(`POST /assets/${ASSET_ID}/revise`)).toBe(1);
  });

  it("ineligible explains each failed check", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    setup({
      [ASSET]: () =>
        json(
          asset({
            status: "ineligible",
            status_reason: "grade_below_c",
            latest_report: { ...REPORT, grade: "CCC" },
          }),
        ),
    });
    expect(
      await screen.findByRole("heading", { name: "Not eligible to list" }),
    ).toBeVisible();
    expect(screen.getByText(/grade came out below C/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Start a new listing" }),
    ).toHaveAttribute("href", `/steward/list?community=${SELVA.id}`);
    expect(
      screen.queryByRole("button", { name: /Try the rating again/ }),
    ).toBeNull();
  });
});

describe("resuming", () => {
  it("opens a draft on its review and edits only what changed", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    const backend = setup({
      // Revised after a rating: its earlier run isn't shown on the draft.
      [ASSET]: () => json(asset({ latest_run_id: RUN_ID })),
      [`PATCH /assets/${ASSET_ID}`]: () =>
        json(
          { detail: "edit_rate_limited" },
          { status: 429, headers: { "Retry-After": "120" } },
        ),
    });
    expect(await screen.findByText("Ready to rate")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Laguna Verde",
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    expect(screen.getByLabelText("Site name")).toHaveValue("Laguna Verde");
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(screen.getByLabelText(/What the land is/), {
      target: { value: "Mangroves we restore." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Continue to boundary/ }),
    );
    expect(await screen.findByText(/Try again in 2 minutes/)).toBeVisible();
    expect(backend.calls(`GET /runs/${RUN_ID}`)).toBe(0);
    expect(await bodyOf(backend, `PATCH /assets/${ASSET_ID}`)).toEqual({
      description: "Mangroves we restore.",
    });
  });

  it("an edit the backend finds unchanged (400 no_changes) still moves on", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    const backend = setup({
      [ASSET]: () => json(asset()),
      [`PATCH /assets/${ASSET_ID}`]: () =>
        json({ detail: "no_changes" }, { status: 400 }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    // A full-width "Ｌ": the backend's NFKC folding makes it the saved name.
    fireEvent.change(screen.getByLabelText("Site name"), {
      target: { value: "\uFF2Caguna Verde" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Continue to boundary/ }),
    );
    expect(
      await screen.findByRole("heading", { name: "Draw the boundary" }),
    ).toBeVisible();
    expect(backend.calls(`PATCH /assets/${ASSET_ID}`)).toBe(1);
  });

  it("refuses a listing of another community", async () => {
    nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
    setup({
      [ASSET]: () =>
        json(asset({ community_id: "77777777-7777-4777-8777-777777777777" })),
    });
    expect(
      await screen.findByText("This listing belongs to another community"),
    ).toBeVisible();
  });

  it("a malformed asset link is not found", async () => {
    nav.search = `community=${SELVA.id}&asset=not-a-uuid`;
    const backend = setup();
    expect(
      await screen.findByText("We couldn't find that listing"),
    ).toBeVisible();
    expect(backend.calls("GET /assets/not-a-uuid")).toBe(0);
  });
});

const OTHER_RUN = "99999999-0000-4999-8999-999999999999";
const resumeAt = () => {
  nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
};

describe("following the run (review fixes)", () => {
  it.each([
    [
      "goes stale",
      ratingRun({ status: "failed", error: "stale" }),
      asset({
        status: "rating",
        status_reason: "rating_stale",
        latest_run_id: RUN_ID,
      }),
      "The rating stopped",
    ],
    [
      "finishes",
      ratingRun({ status: "succeeded", steps: [step("done", "succeeded")] }),
      asset({ status: "listed", latest_report: REPORT }),
      "Laguna Verde is listed",
    ],
  ])(
    "a run that %s with no listing event still updates the listing",
    async (_label, ended, after, heading) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        resumeAt();
        let current = asset({ status: "rating", latest_run_id: RUN_ID });
        let run = ratingRun({ status: "running" });
        const backend = setup({
          [ASSET]: () => json(current),
          [`GET /runs/${RUN_ID}`]: () => json(run),
        });
        expect(
          await screen.findByRole("heading", { name: "Rating in progress" }),
        ).toBeVisible();
        await waitFor(() =>
          expect(backend.calls(`GET /runs/${RUN_ID}`)).toBe(1),
        );
        current = after;
        run = ended;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(
          await screen.findByRole("heading", { name: heading }),
        ).toBeVisible();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("ignores duplicate, replayed and out-of-order events: the server's run decides", async () => {
    resumeAt();
    const backend = setup({
      [ASSET]: () => json(asset({ status: "rating", latest_run_id: RUN_ID })),
      [`GET /runs/${RUN_ID}`]: () =>
        json(
          ratingRun({
            status: "running",
            steps: [step("queued", "queued"), step("earth_obs", "ok")],
          }),
        ),
    });
    const row = (label: string) =>
      screen.getByText(label, { selector: "span" }).closest("li")!;
    await waitFor(() =>
      expect(row("Satellite data")).toHaveTextContent("done"),
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const stream = FakeEventSource.latest();
    act(() => {
      stream.open();
      const emit = (id: number, payload: Record<string, unknown>) =>
        stream.emit("rating_progress", id, {
          run_id: RUN_ID,
          asset_id: ASSET_ID,
          ...payload,
        });
      emit(5, { step: "audit", status: "ok" });
      emit(5, { step: "audit", status: "ok" }); // duplicate
      emit(4, { step: "done", status: "failed" }); // out of order: dropped
      emit(6, { step: "earth_obs", status: "failed" }); // claims a regression
    });
    await waitFor(() =>
      expect(backend.calls(`GET /runs/${RUN_ID}`)).toBeGreaterThan(1),
    );
    // Only what GET /runs/{id} says is shown.
    expect(row("Satellite data")).toHaveTextContent("done");
    expect(row("Audit")).toHaveTextContent("waiting");
    expect(row("Sealed report")).toHaveTextContent("waiting");
  });

  it("switches to another run of the listing when one starts", async () => {
    resumeAt();
    let current = asset({
      status: "rating",
      status_reason: "rating_stale",
      latest_run_id: RUN_ID,
    });
    const backend = setup({
      [ASSET]: () => json(current),
      [`GET /runs/${RUN_ID}`]: () =>
        json(ratingRun({ status: "failed", error: "stale" })),
      [`GET /runs/${OTHER_RUN}`]: () =>
        json(ratingRun({ run_id: OTHER_RUN, status: "queued" })),
    });
    expect(
      await screen.findByRole("heading", { name: "The rating stopped" }),
    ).toBeVisible();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    current = asset({ status: "rating", latest_run_id: OTHER_RUN });
    act(() => {
      const stream = FakeEventSource.latest();
      stream.open();
      stream.emit("rating_progress", 1, {
        run_id: OTHER_RUN,
        asset_id: ASSET_ID,
        step: "queued",
        status: "queued",
      });
    });
    expect(
      await screen.findByRole("heading", { name: "Rating in progress" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(backend.calls(`GET /runs/${OTHER_RUN}`)).toBeGreaterThan(0),
    );
    expect(screen.getByText(/Queued for a rating worker/)).toBeVisible();
  });

  it("409 run_in_progress follows the run already going", async () => {
    resumeAt();
    let current = asset({
      status: "rating",
      status_reason: "rating_stale",
      latest_run_id: RUN_ID,
    });
    const backend = setup({
      [ASSET]: () => json(current),
      [`GET /runs/${RUN_ID}`]: () =>
        json(ratingRun({ status: "failed", error: "stale" })),
      [`GET /runs/${OTHER_RUN}`]: () =>
        json(ratingRun({ run_id: OTHER_RUN, status: "running" })),
      [`POST /assets/${ASSET_ID}/submit`]: () => {
        current = asset({ status: "rating", latest_run_id: OTHER_RUN });
        return json(
          { detail: "run_in_progress" },
          { status: 409, headers: { Location: `/runs/${OTHER_RUN}` } },
        );
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /Try the rating again/ }),
    );
    expect(
      await screen.findByText("A rating is already running"),
    ).toBeVisible();
    await waitFor(() =>
      expect(backend.calls(`GET /runs/${OTHER_RUN}`)).toBeGreaterThan(0),
    );
    expect(
      await screen.findByRole("heading", { name: "Rating in progress" }),
    ).toBeVisible();
  });
});

describe("the boundary step (review fixes)", () => {
  it("fetches the outlines once, not on every visit to the step", async () => {
    const backend = setup();
    await fillDetails();
    await screen.findByRole("button", { name: "Add test corner" });
    await waitFor(() => expect(backend.calls("GET /assets/outlines")).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Continue to boundary/ }),
    );
    await screen.findByRole("button", { name: "Add test corner" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.calls("GET /assets/outlines")).toBe(1);
  });

  it("says overlap is checked on save when the outlines were cut off", async () => {
    setup({
      "GET /assets/outlines": () => json({ outlines: [], truncated: true }),
    });
    await fillDetails();
    await drawSquare();
    expect(
      await screen.findByText(/NatureX checks overlaps with other sites/),
    ).toBeVisible();
    expect(screen.queryByText(/overlap look right/)).toBeNull();
  });

  it("saves once on a double click", async () => {
    let release = () => {};
    const backend = setup({
      "POST /assets": () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(asset(), { status: 201 }));
        }),
      [ASSET]: () => json(asset()),
    });
    await fillDetails();
    await drawSquare();
    const save = screen.getByRole("button", { name: /Save draft/ });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.doubleClick(save);
    await waitFor(() => expect(backend.calls("POST /assets")).toBe(1));
    act(() => release());
    expect(await screen.findByText("Ready to rate")).toBeVisible();
    expect(backend.calls("POST /assets")).toBe(1);
  });

  it("adds corners from typed coordinates, and a clear can be undone", async () => {
    setup();
    await fillDetails();
    const typed = await screen.findByLabelText("Coordinates");
    for (const corner of ["0, 0", "0, 0.01", "0.01, 0.01", "0.01 0"]) {
      fireEvent.change(typed, { target: { value: corner } });
      fireEvent.click(
        screen.getByRole("button", { name: "Add a corner here" }),
      );
    }
    expect(screen.getByText("4 corners")).toBeVisible();
    fireEvent.change(typed, { target: { value: "north" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a corner here" }));
    expect(screen.getByText(/Type latitude, longitude/)).toBeVisible();
    expect(screen.getByText("4 corners")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("0 corners")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Undo clear" }));
    expect(screen.getByText("4 corners")).toBeVisible();
  });

  it("a 401 while saving offers sign-in and keeps the listing in this tab", async () => {
    window.history.replaceState({}, "", `/steward/list?community=${SELVA.id}`);
    setup({
      "POST /assets": () => json({ detail: "auth_required" }, { status: 401 }),
    });
    await fillDetails();
    await drawSquare();
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));
    expect(await screen.findByText("Your session has ended")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Sign in again/ }).getAttribute("href"),
    ).toBe(
      `/login?next=${encodeURIComponent(`/steward/list?community=${SELVA.id}`)}`,
    );
    const kept = JSON.parse(
      window.sessionStorage.getItem(
        `nx-listing-draft:${SIGNED_IN_WORLD.me!.id}:${SELVA.id}`,
      )!,
    );
    expect(kept.form.name).toBe("Laguna Verde");
    expect(kept.points).toHaveLength(4);
  });

  it("restores a listing kept in this tab, with the attestation to confirm again", async () => {
    window.sessionStorage.setItem(
      `nx-listing-draft:${SIGNED_IN_WORLD.me!.id}:${SELVA.id}`,
      JSON.stringify({
        form: { name: "Laguna Verde", country: "MX", description: "" },
        points: CORNERS,
      }),
    );
    setup();
    await realForm();
    expect(screen.getByLabelText("Site name")).toHaveValue("Laguna Verde");
    expect(screen.getByText(/We kept what you entered/)).toBeVisible();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});

describe("the details step (review fixes)", () => {
  it("focuses the first invalid field", async () => {
    setup();
    await realForm();
    fireEvent.change(screen.getByLabelText(/Country code/), {
      target: { value: "Mexico" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Continue to boundary/ }),
    );
    expect(screen.getByLabelText("Site name")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Site name"), {
      target: { value: "Laguna Verde" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Continue to boundary/ }),
    );
    expect(screen.getByLabelText(/Country code/)).toHaveFocus();
  });

  it("shows a loader, not the prototype, until the session answers", async () => {
    let answer = () => {};
    setup({
      "GET /world": () =>
        new Promise<Response>((resolve) => {
          answer = () => resolve(json(SIGNED_IN_WORLD));
        }),
    });
    expect(await screen.findByText("Loading…")).toBeVisible();
    expect(screen.queryByText(/Prefilled for the demo site/)).toBeNull();
    act(() => answer());
    expect(await realForm()).toBeVisible();
  });
});

describe("links from the Steward home (T63)", () => {
  it.each([
    ["continue_listing", asset(), "Ready to rate"],
    [
      "add_evidence",
      asset({ status: "needs_evidence", status_reason: "confidence_below_70" }),
      "Needs more evidence",
    ],
  ] as const)(
    "%s opens that listing here",
    async (action, listing, heading) => {
      const href = listingAction(action, ASSET_ID, SELVA.id).href!;
      const url = new URL(href, "http://test.local");
      expect(url.pathname).toBe("/steward/list");
      nav.search = url.search.slice(1);
      setup({ [ASSET]: () => json(listing) });
      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeVisible();
    },
  );
});
