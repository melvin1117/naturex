import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

import { ListedStep } from "@/components/listing/listed-step";
import { ListingScreen } from "@/components/listing/listing-screen";
import { StewardCommunityProvider } from "@/components/shell/steward-community";
import { WorldProvider } from "@/components/world-provider";
import type {
  AssetDetail,
  CommunitySummary,
  ListingSummary,
  RatingRun,
  ReportOut,
} from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { PIPELINE_SETTLE_MS, PIPELINE_STEP_MS } from "@/lib/listing/pacing";
import { DURATION } from "@/lib/motion";
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
import { stubMotion } from "../motion";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/steward/list",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const SELVA = community();
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "88888888-8888-4888-8888-888888888888";

const REPORT = {
  id: "99999999-9999-4999-8999-999999999999",
  asset_id: ASSET_ID,
  version: 1,
  grade: "AA",
  health_score: "85.10",
  confidence: "71.00",
  value_low: "2800000",
  value_mid: "4300000",
  value_high: "4300000",
  summary_source: "fallback",
  simulated: false,
  created_at: "2026-10-19T00:00:00Z",
} as unknown as ReportOut;

const ANNOUNCED =
  "Laguna Verde is listed. Grade AA, Very strong health: health 85.1 out of 100. Estimated value $2.8M to $4.3M a year, midpoint $4.3M. 71% confidence.";

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
    geojson: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [0.01, 0],
          [0.01, 0.01],
          [0, 0.01],
          [0, 0],
        ],
      ],
    },
    primary_shares_remaining: 0,
    community_wallet: "0.00",
    mock: false,
    latest_report: null,
    recent_events: [],
    trading: false,
    ...overrides,
  } as AssetDetail;
}

const step = (name: string, status: string, extra: object = {}) => ({
  step: name,
  status,
  prompt_tokens: 0,
  completion_tokens: 0,
  ...extra,
});

/** A mock run: all seven steps finished in one burst (evidence not run). */
const FINISHED: RatingRun = {
  run_id: RUN_ID,
  asset_id: ASSET_ID,
  status: "succeeded",
  degraded: false,
  reasons: [],
  steps: [
    step("queued", "queued"),
    step("earth_obs", "ok", { latency_ms: 1500 }),
    step("valuation", "ok", { latency_ms: 30 }),
    step("news", "ok"),
    step("audit", "ok"),
    step("done", "succeeded"),
  ],
};

let motion: ReturnType<typeof stubMotion> | null = null;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
});

beforeEach(() => {
  FakeEventSource.reset();
  nav.search = `community=${SELVA.id}&asset=${ASSET_ID}`;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  motion?.restore();
  motion = null;
});

/**
 * Rate a draft; the run then finishes in one burst and the listing is listed. With
 * `finishedOnFirstRead`, the run has already finished when the screen first reads it.
 */
async function rateInABurst({ finishedOnFirstRead = false } = {}) {
  let current = asset();
  let run: RatingRun = { ...FINISHED, status: "queued", steps: [] };
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    "GET /me/communities": () => json([SELVA]),
    "GET /assets/outlines": () => json({ outlines: [], truncated: false }),
    [`GET /assets/${ASSET_ID}`]: () => json(current),
    [`GET /runs/${RUN_ID}`]: () => json(run),
    [`POST /assets/${ASSET_ID}/submit`]: () => {
      current = asset({ status: "rating", latest_run_id: RUN_ID });
      if (finishedOnFirstRead) run = FINISHED;
      return json(
        { asset_id: ASSET_ID, run_id: RUN_ID, status: "rating" },
        { status: 202 },
      );
    },
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
  fireEvent.click(
    await screen.findByRole("button", { name: /Rate this site/ }),
  );
  await screen.findByRole("heading", { name: "Rating in progress" });
  await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
  current = asset({ status: "listed", latest_report: REPORT });
  run = FINISHED;
  act(() => {
    const stream = FakeEventSource.latest();
    stream.open();
    stream.emit("rating_progress", 1, {
      run_id: RUN_ID,
      asset_id: ASSET_ID,
      step: "done",
      status: "succeeded",
      listing_status: "listed",
    });
  });
}

const pipeline = () => screen.getByRole("region", { name: "Rating pipeline" });
const finishedRows = () =>
  within(pipeline())
    .getAllByRole("listitem")
    .filter((row) => /(done|not run)$/.test(row.textContent ?? "")).length;

describe("the rating reveal (#216)", () => {
  it("replays a burst step by step, then reveals the listing", async () => {
    motion = stubMotion();
    await rateInABurst();
    // Every change of the finished-step count, with when it happened.
    const seen: { at: number; count: number }[] = [];
    const record = () => {
      const count = finishedRows();
      if (count !== seen.at(-1)?.count) seen.push({ at: Date.now(), count });
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(pipeline(), {
      subtree: true,
      childList: true,
      characterData: true,
    });
    await waitFor(
      () =>
        expect(within(pipeline()).getByRole("status")).toHaveTextContent(
          "Rating finished.",
        ),
      { timeout: 8 * PIPELINE_STEP_MS },
    );
    observer.disconnect();
    // One step that ran at a time, a beat apart (give or take render jitter): none invented,
    // none skipped; "Field evidence" (not run) shows with "Local news" before it. Unpaced, the
    // burst would land all at once.
    const counts = seen.map((s) => s.count).filter((c) => c > 0);
    expect(counts).toEqual([1, 2, 3, 5, 6, 7]);
    for (let i = 1; i < seen.length; i++)
      if (seen[i - 1].count > 0)
        expect(seen[i].at - seen[i - 1].at).toBeGreaterThanOrEqual(
          PIPELINE_STEP_MS / 2,
        );
    // The finished run stays on screen for a beat, with the way to its trace.
    expect(
      screen.queryByRole("heading", { name: /is listed/ }),
    ).not.toBeInTheDocument();
    expect(
      within(pipeline()).getByRole("button", {
        name: /See every step in the Agent Trace/,
      }),
    ).toBeVisible();

    // Then the listed step reveals: dial and count, stamp, the exact numbers, one announcement.
    expect(
      await screen.findByRole(
        "heading",
        { name: "Laguna Verde is listed" },
        { timeout: PIPELINE_SETTLE_MS + 1000 },
      ),
    ).toBeVisible();
    const dial = screen.getByRole("img", { name: "Health 85.1 out of 100" });
    expect(dial.querySelectorAll("g.nx-dot-on").length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: /^Grade AA/ })).toHaveClass(
      "nx-stamp",
    );
    await waitFor(() => expect(dial).toHaveTextContent("85.1"), {
      timeout: DURATION.reveal + 1000,
    });
    expect(await screen.findByText(ANNOUNCED)).toHaveAttribute(
      "role",
      "status",
    );
  }, 15_000);

  it("replays a run that had already finished when first read", async () => {
    motion = stubMotion();
    await rateInABurst({ finishedOnFirstRead: true });
    expect(finishedRows()).toBeLessThan(7);
    await waitFor(() => expect(finishedRows()).toBe(7), {
      timeout: 8 * PIPELINE_STEP_MS,
    });
    expect(
      await screen.findByRole(
        "heading",
        { name: "Laguna Verde is listed" },
        { timeout: PIPELINE_SETTLE_MS + 1000 },
      ),
    ).toBeVisible();
  }, 15_000);

  it("under reduced motion lists at once, with the same numbers and announcement", async () => {
    motion = stubMotion({ reduce: true });
    await rateInABurst();
    expect(
      await screen.findByRole("heading", { name: "Laguna Verde is listed" }),
    ).toBeVisible();
    expect(
      screen.getByRole("img", { name: "Health 85.1 out of 100" }),
    ).toHaveTextContent("85.1");
    expect(screen.getByRole("img", { name: /^Grade AA/ })).not.toHaveClass(
      "nx-stamp",
    );
    expect(await screen.findByText(ANNOUNCED)).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("on a phone the run leads the step and scrolls into view", async () => {
    motion = stubMotion({ stacked: true });
    await rateInABurst();
    // In the DOM too, not only on screen: the pipeline comes before the step card.
    const title = await screen.findByRole("heading", {
      name: "Rating in progress",
    });
    expect(
      pipeline().compareDocumentPosition(title) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "smooth",
    });
    // The person's place stays theirs: focus is on the step's title, not pulled away.
    expect(
      screen.getByRole("heading", { name: "Rating in progress" }),
    ).toHaveFocus();
  });
});

describe("ListedStep", () => {
  // As the API sends a listed site: its run is on its report, not in `latest_run_id`.
  const listed = asset({
    status: "listed",
    latest_report: { ...REPORT, run_id: RUN_ID },
  });

  /** The Steward home's summary of this listing, as the API sends it. */
  function summaryOf(
    next_action: ListingSummary["next_action"],
    verification: ListingSummary["verification"],
  ): CommunitySummary {
    return {
      community: { ...SELVA, created_at: "2026-10-18T00:00:00Z" },
      role: "owner",
      listings: [
        {
          asset: {
            id: ASSET_ID,
            name: listed.name,
            status: "listed",
            trading: false,
            area_ha: "225.00",
            sparkline: [],
            mock: true,
          } as ListingSummary["asset"],
          next_action,
          verification,
          ipo_at: null,
          updated_at: "2026-10-18T00:00:00Z",
          manage_actions: [],
          wallet: {
            balance: "0.00",
            ipo_proceeds: "0.00",
            community_fund_payouts: "0.00",
            retained_dividends: "0.00",
            total_received: "0.00",
          },
          holders: { count: 0, shares_held: 0, top: [] },
          shares: null,
          recommendations: [],
          report_version: 1,
        },
      ],
      wallet: {
        balance: "0.00",
        ipo_proceeds: "0.00",
        community_fund_payouts: "0.00",
        retained_dividends: "0.00",
        total_received: "0.00",
      },
      holder_count: 0,
      payouts: [],
      payouts_count: 0,
    } as CommunitySummary;
  }

  const NEEDS_VERIFYING = summaryOf("verify", {
    level: "unverified",
    in_review: false,
    required: true,
  });

  function renderListed(
    reveal: boolean,
    onOpenTrace = vi.fn(),
    summary: () => Response | Promise<Response> = () => json(NEEDS_VERIFYING),
    site = listed,
  ) {
    const backend = fakeBackend({
      "GET /world": () => json(SIGNED_IN_WORLD),
      [`GET /communities/${SELVA.id}/summary`]: summary,
    });
    const layer = createDataLayer({
      baseUrl: BASE,
      fetch: backend.fetch,
      createEventSource: createFakeEventSource,
    });
    const view = render(
      <ListedStep
        community={SELVA}
        asset={site}
        reveal={reveal}
        onOpenTrace={onOpenTrace}
      />,
      {
        wrapper: ({ children }) => (
          <WorldProvider dataLayer={layer}>{children}</WorldProvider>
        ),
      },
    );
    return { ...view, onOpenTrace };
  }

  it("sends a listing the live offer waits on to verification first (#216)", async () => {
    motion = stubMotion();
    renderListed(false);
    const verify = await screen.findByRole("link", {
      name: "Verify this listing",
    });
    expect(verify).toHaveAttribute(
      "href",
      `/steward/assets/${ASSET_ID}/verify?community=${SELVA.id}`,
    );
    expect(
      screen.getByRole("link", { name: "Preview the opening offer" }),
    ).toHaveAttribute(
      "href",
      `/steward/assets/${ASSET_ID}/ipo?community=${SELVA.id}`,
    );
    expect(screen.getByText("Not verified")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Set up the opening offer/ }),
    ).toBeNull();
  });

  it.each([
    ["before its launch: a preview", null, "Preview the site page"],
    ["once launched: public", "2026-10-20T15:00:00Z", "See the public page"],
  ])("links to the site page, %s", async (_when, ipoAt, name) => {
    motion = stubMotion();
    renderListed(false, vi.fn(), () => json(NEEDS_VERIFYING), {
      ...listed,
      ipo_at: ipoAt,
    });
    expect(await screen.findByRole("link", { name })).toHaveAttribute(
      "href",
      expect.stringContaining(ASSET_ID),
    );
  });

  it("goes straight to the offer once verified", async () => {
    motion = stubMotion();
    renderListed(false, vi.fn(), () =>
      json(
        summaryOf("launch_ipo", {
          level: "verified",
          in_review: false,
          required: false,
          decided_at: "2026-10-20T15:00:00Z",
        }),
      ),
    );
    expect(
      await screen.findByRole("link", { name: /Open to supporters/ }),
    ).toHaveAttribute(
      "href",
      `/steward/assets/${ASSET_ID}/ipo?community=${SELVA.id}`,
    );
    expect(screen.getByText("Verified")).toBeVisible();
  });

  it("falls back to the offer, which explains any blocker, without the summary", async () => {
    motion = stubMotion();
    renderListed(false, vi.fn(), () =>
      json({ detail: "boom" }, { status: 500 }),
    );
    expect(
      await screen.findByRole("link", { name: /Set up the opening offer/ }),
    ).toHaveAttribute(
      "href",
      `/steward/assets/${ASSET_ID}/ipo?community=${SELVA.id}`,
    );
  });

  it("announces a new rating once, even when the listing is re-read", async () => {
    motion = stubMotion();
    const { rerender } = renderListed(true);
    expect(await screen.findByText(ANNOUNCED)).toBeInTheDocument();
    rerender(
      <ListedStep
        community={SELVA}
        asset={{ ...listed, community_wallet: "10.00" }}
        reveal
        onOpenTrace={vi.fn()}
      />,
    );
    expect(screen.getAllByText(ANNOUNCED)).toHaveLength(1);
  });

  it("a listing opened later is shown as it is: no count, no stamp, no announcement", async () => {
    motion = stubMotion();
    renderListed(false);
    expect(
      screen.getByRole("img", { name: "Health 85.1 out of 100" }),
    ).toHaveTextContent("85.1");
    expect(screen.getByRole("img", { name: /^Grade AA/ })).not.toHaveClass(
      "nx-stamp",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText(ANNOUNCED)).not.toBeInTheDocument();
  });

  it.each([
    ["with motion", false],
    ["under reduced motion", true],
  ])("keeps the way to the rating's Agent Trace (%s)", (_label, reduce) => {
    motion = stubMotion({ reduce });
    const { onOpenTrace } = renderListed(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "See every step in the Agent Trace",
      }),
    );
    expect(onOpenTrace).toHaveBeenCalledWith(RUN_ID);
  });
});
