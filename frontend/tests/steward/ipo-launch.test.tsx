import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import IpoPage from "@/app/steward/assets/[id]/ipo/page";
import { IpoLaunch } from "@/components/ipo-launch";
import { WorldProvider } from "@/components/world-provider";
import type {
  AssetDetail,
  IpoOut,
  IpoPreview,
  WorldOut,
} from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
  SIGNED_IN_WORLD,
  WORLD,
} from "../lib/helpers";
import { asset as assetFixture, ASSET_ID } from "../trade/fixtures";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => `/steward/assets/${ASSET_ID}/ipo`,
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  // jsdom lacks these; the Radix slider and dialog ask for them.
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
});

const ASSET = `GET /assets/${ASSET_ID}`;
const PREVIEW = `GET /assets/${ASSET_ID}/ipo/preview`;
const LAUNCH = `POST /assets/${ASSET_ID}/ipo`;
const FORMULA =
  "fair_value_total = value_mid × 10 × health_factor × confidence_factor; ipo_price = fair_value_per_share = fair_value_total / total_shares; shares_offered = total_shares × (1 − retained_pct/100)";

const unlaunched = (overrides: Partial<AssetDetail> = {}) =>
  assetFixture({
    name: "Río Claro Forest",
    trading: false,
    ipo_at: null,
    price: null,
    total_shares: null,
    retained_pct: null,
    primary_shares_remaining: 0,
    ...overrides,
  });

/** A preview as the backend writes it; canned terms that no browser formula could produce. */
function preview(overrides: Partial<IpoPreview> = {}): IpoPreview {
  return {
    asset_id: ASSET_ID,
    report_id: "88888888-8888-4888-8888-888888888888",
    report_version: 3,
    formula: FORMULA,
    value_mid: "1234567.00",
    health: "78.40",
    confidence: "85.00",
    health_factor: "0.8920",
    confidence_factor: "0.9550",
    fair_value_total: "10517290.12",
    total_shares: 1_000_000,
    fair_value_per_share: "10.5173",
    ipo_price: "10.5173",
    retained_pct: "51.00",
    shares_offered: 490_000,
    retained_shares: 510_000,
    launchable: true,
    blocked_reason: null,
    ...overrides,
  };
}

/** Echo the offering asked for, like the backend does, with a price per input. */
function previewFor(request: Request, overrides: Partial<IpoPreview> = {}) {
  const url = new URL(request.url);
  const total = Number(url.searchParams.get("total_shares"));
  const retained = url.searchParams.get("retained_pct") ?? "51";
  const price = total === 2_000_000 ? "5.2587" : "10.5173";
  return json(
    preview({
      total_shares: total,
      retained_pct: Number(retained).toFixed(2),
      ipo_price: price,
      fair_value_per_share: price,
      ...overrides,
    }),
  );
}

const launched = (overrides: Partial<IpoOut> = {}): IpoOut => ({
  ...preview(),
  launched_at: "2026-10-19T00:00:00Z",
  ...overrides,
});

const refused = (status: number, code: string) =>
  json({ detail: code }, { status });

type Routes = Parameters<typeof fakeBackend>[0];

function renderLaunch(routes: Routes = {}, world: WorldOut = SIGNED_IN_WORLD) {
  const backend = fakeBackend({
    "GET /world": () => json(world),
    [ASSET]: () => json(unlaunched()),
    [PREVIEW]: (request) => previewFor(request),
    [LAUNCH]: () => json(launched(), { status: 201 }),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <IpoLaunch assetId={ASSET_ID} />
    </WorldProvider>,
  );
  return { backend, layer };
}

const steps = () =>
  screen.findByRole("list", { name: "How the opening price is computed" });
const launchButton = () =>
  screen.getByRole("button", { name: "Launch opening offer" });

function previewQueries(backend: ReturnType<typeof fakeBackend>) {
  return backend.requests
    .filter((r) => r.method === "GET" && r.url.includes("/ipo/preview"))
    .map((r) => Object.fromEntries(new URL(r.url).searchParams));
}

async function confirmLaunch() {
  await waitFor(() => expect(launchButton()).toBeEnabled());
  fireEvent.click(launchButton());
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: /^Launch at .* per unit$/ }),
  );
}

describe("IPO launch screen", () => {
  it("shows every term of the backend's price formula, labelled", async () => {
    const { backend } = renderLaunch();

    const list = await steps();
    const text = list.textContent ?? "";
    expect(text).toContain("$1,234,567.00/yr");
    expect(text).toContain("× 10");
    expect(text).toContain("health 78.4/100");
    expect(text).toContain("× 0.892");
    expect(text).toContain("confidence 85/100");
    expect(text).toContain("× 0.955");
    expect(text).toContain("$10,517,290.12");
    expect(text).toContain("÷ 1,000,000");
    expect(text).toContain("$10.5173");
    expect(screen.getByTestId("ipo-price")).toHaveTextContent("$10.5173");
    expect(screen.getByText("From rating report v3")).toBeInTheDocument();
    expect(screen.getByText("490,000")).toBeInTheDocument();
    expect(screen.getByText("510,000 units")).toBeInTheDocument();
    expect(screen.getByText(/keeps \(51%\)/)).toBeInTheDocument();
    expect(screen.getByText(FORMULA)).toBeInTheDocument();
    expect(
      screen.getByText(/play money, not a real security/),
    ).toBeInTheDocument();
    expect(previewQueries(backend)).toEqual([
      { total_shares: "1000000", retained_pct: "51" },
    ]);
  });

  it("debounces new previews as the inputs change", async () => {
    const { backend } = renderLaunch();
    await steps();

    const shares = screen.getByLabelText("Units to issue");
    fireEvent.change(shares, { target: { value: "2,0" } });
    fireEvent.change(shares, { target: { value: "2,000,000" } });
    fireEvent.change(screen.getByLabelText("Community keeps"), {
      target: { value: "60.5" },
    });
    expect(shares).toHaveValue("2000000");
    // The stale preview stays, dimmed, and can't be launched.
    expect(screen.getByText("Updating the preview…")).toBeInTheDocument();
    expect(launchButton()).toBeDisabled();

    await waitFor(() =>
      expect(screen.getByTestId("ipo-price")).toHaveTextContent("$5.2587"),
    );
    expect(previewQueries(backend)).toEqual([
      { total_shares: "1000000", retained_pct: "51" },
      { total_shares: "2000000", retained_pct: "60.5" },
    ]);
    await waitFor(() => expect(launchButton()).toBeEnabled());
  });

  it("moves the retained % with the named slider too", async () => {
    renderLaunch();
    await steps();

    const slider = screen.getByRole("slider", {
      name: "Share of the stake the community keeps",
    });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.getByLabelText("Community keeps")).toHaveValue("52");
    await waitFor(() =>
      expect(screen.getByText(/keeps \(52%\)/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Opening price $10.5173 per unit, 490,000 units offered.",
    );
  });

  it("explains invalid inputs and asks for no preview", async () => {
    const { backend } = renderLaunch();
    await steps();

    fireEvent.change(screen.getByLabelText("Units to issue"), {
      target: { value: "9999" },
    });
    expect(screen.getByLabelText("Units to issue")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    fireEvent.change(screen.getByLabelText("Community keeps"), {
      target: { value: "95" },
    });
    expect(screen.getByLabelText("Community keeps")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      await screen.findByText("Enter a valid offer to see its price."),
    ).toBeInTheDocument();
    expect(launchButton()).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(backend.calls(PREVIEW)).toBe(1);
  });

  it("launches at the previewed price and links to the Exchange", async () => {
    const { backend } = renderLaunch();
    await steps();
    await confirmLaunch();

    const heading = await screen.findByRole("heading", {
      name: "Río Claro Forest is open to supporters",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(
      screen.getByText(/Opening price \$10\.5173 per unit/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /See it on the Exchange/ }),
    ).toHaveAttribute("href", `/asset/${ASSET_ID}`);
    expect(
      screen.getAllByRole("link", { name: "Community home" })[0],
    ).toHaveAttribute("href", "/steward");

    const post = backend.requests.find((r) => r.method === "POST")!;
    expect(await post.json()).toEqual({
      total_shares: 1_000_000,
      retained_pct: "51.00",
      expected_price: "10.5173",
    });
    expect(backend.calls(LAUNCH)).toBe(1);
  });

  it("asks before launching; cancelling launches nothing", async () => {
    const { backend } = renderLaunch();
    await steps();
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());

    const dialog = await screen.findByRole("dialog", {
      name: "Open Río Claro Forest to supporters?",
    });
    expect(dialog).toHaveTextContent("can't be undone");
    expect(dialog).toHaveTextContent("$10.5173");
    expect(dialog).toHaveTextContent("490,000");
    expect(dialog).toHaveTextContent(/play money, not a real security/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(launchButton()).toHaveFocus());
    expect(backend.calls(LAUNCH)).toBe(0);
  });

  it("sends the offering of the preview it shows", async () => {
    const { backend } = renderLaunch();
    await steps();
    fireEvent.change(screen.getByLabelText("Units to issue"), {
      target: { value: "2000000" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("ipo-price")).toHaveTextContent("$5.2587"),
    );
    await confirmLaunch();

    await screen.findByText(/is open to supporters/);
    const post = backend.requests.find((r) => r.method === "POST")!;
    expect(await post.json()).toEqual({
      total_shares: 2_000_000,
      retained_pct: "51.00",
      expected_price: "5.2587",
    });
  });

  it.each([
    ["run_in_progress", /A rating is running/],
    ["ipo_price_too_high", /Issue more units/],
    [
      "verification_required",
      /until this listing's land documents are verified/,
    ],
    ["not_verified", /until this listing's land documents are verified/],
    ["something_new", /can't launch right now/],
  ])("explains blocked_reason %s and won't launch", async (code, message) => {
    const { backend } = renderLaunch({
      [PREVIEW]: (request) =>
        previewFor(request, { launchable: false, blocked_reason: code }),
    });
    await steps();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
    expect(launchButton()).toBeDisabled();
    expect(backend.calls(LAUNCH)).toBe(0);
  });

  it("explains a price that rounds to zero and keeps the form", async () => {
    renderLaunch({ [PREVIEW]: () => refused(409, "ipo_price_too_low") });

    expect(await screen.findByText(/Issue fewer units/)).toBeInTheDocument();
    expect(screen.getByLabelText("Units to issue")).toBeInTheDocument();
    expect(launchButton()).toBeDisabled();
  });

  it("re-previews after ipo_price_changed and launches at the new price", async () => {
    const { backend } = renderLaunch({
      [PREVIEW]: sequence(
        () => json(preview()),
        () => json(preview({ ipo_price: "11.0021" })),
      ),
      [LAUNCH]: sequence(
        () => refused(409, "ipo_price_changed"),
        () => json(launched({ ipo_price: "11.0021" }), { status: 201 }),
      ),
    });
    await steps();
    await confirmLaunch();

    expect(
      await screen.findByText("The opening price changed"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("ipo-price")).toHaveTextContent("$11.0021"),
    );
    await confirmLaunch();

    await screen.findByText(/is open to supporters/);
    const posts = backend.requests.filter((r) => r.method === "POST");
    expect((await posts[0]!.json()).expected_price).toBe("10.5173");
    expect((await posts[1]!.json()).expected_price).toBe("11.0021");
  });

  it.each([
    ["run_in_progress", /A rating is running/],
    ["ipo_price_too_high", /Issue more units/],
    ["ipo_price_too_low", /Issue fewer units/],
    ["verification_required", /land documents are verified/],
  ])("explains a launch refused with %s", async (code, message) => {
    renderLaunch({ [LAUNCH]: () => refused(409, code) });
    await steps();
    await confirmLaunch();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText("Units to issue")).toBeInTheDocument();
  });

  it("explains a launch that fails for another reason", async () => {
    renderLaunch({ [LAUNCH]: () => json({}, { status: 500 }) });
    await steps();
    await confirmLaunch();

    expect(
      await screen.findByText("The opening offer didn't launch"),
    ).toBeInTheDocument();
  });

  it.each([
    ["preview", PREVIEW],
    ["launch", LAUNCH],
  ])(
    "links an already launched asset to the Exchange (%s)",
    async (_where, route) => {
      renderLaunch({ [route]: () => refused(409, "ipo_already_launched") });
      if (route === LAUNCH) {
        await steps();
        await confirmLaunch();
      }

      expect(
        await screen.findByText("This opening offer has launched"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /See it on the Exchange/ }),
      ).toHaveAttribute("href", `/asset/${ASSET_ID}`);
      expect(screen.queryByLabelText("Units to issue")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["draft", /still a draft/],
    ["rating", /rating is still running/],
    ["needs_evidence", /needs more evidence/],
    ["ineligible", /didn't pass the listing gate/],
    ["suspended", /suspended site can't open/],
    ["withdrawn", /withdrawn listing/],
  ] as const)(
    "explains why a %s site can't launch",
    async (status, message) => {
      renderLaunch({
        [ASSET]: () => json(unlaunched({ status })),
        [PREVIEW]: () => refused(409, "asset_not_listed"),
      });

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByLabelText("Units to issue")).not.toBeInTheDocument();
    },
  );

  it("explains a site without a usable rating", async () => {
    renderLaunch({ [PREVIEW]: () => refused(409, "no_rating") });
    expect(
      await screen.findByText("There's no rating to price from"),
    ).toBeInTheDocument();
  });

  it("tells a steward who isn't the owner that only the owner can launch", async () => {
    const { backend } = renderLaunch({
      [PREVIEW]: () => refused(403, "owner_only"),
    });

    expect(
      await screen.findByText("Only the owner can launch"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Units to issue")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /launch/i })).toBeNull();
    expect(backend.calls(LAUNCH)).toBe(0);
  });

  it("tells a steward of an unlisted site that only the owner can launch", async () => {
    // The backend authorizes before it checks the status: 403 wins over 409.
    renderLaunch({
      [ASSET]: () => json(unlaunched({ status: "draft" })),
      [PREVIEW]: () => refused(403, "owner_only"),
    });
    expect(
      await screen.findByText("Only the owner can launch"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/still a draft/)).not.toBeInTheDocument();
  });

  it("says a hidden or missing site can't be found", async () => {
    renderLaunch({
      [ASSET]: () => refused(404, "not_found"),
      [PREVIEW]: () => refused(404, "not_found"),
    });
    expect(
      await screen.findByText("We couldn't find this site"),
    ).toBeInTheDocument();
  });

  it("asks for nothing with an ID that isn't one", async () => {
    const backend = fakeBackend({ "GET /world": () => json(SIGNED_IN_WORLD) });
    const layer = createDataLayer({ baseUrl: BASE, fetch: backend.fetch });
    render(
      <WorldProvider dataLayer={layer}>
        <IpoLaunch assetId="not-a-uuid" />
      </WorldProvider>,
    );
    expect(
      await screen.findByText("We couldn't find this site"),
    ).toBeInTheDocument();
    expect(backend.calls(ASSET) + backend.calls(PREVIEW)).toBe(0);
  });

  it("retries a preview that failed", async () => {
    renderLaunch({
      [PREVIEW]: sequence(
        () => json({}, { status: 500 }),
        (request) => previewFor(request),
      ),
    });

    fireEvent.click(await screen.findByRole("button", { name: /Try again/ }));
    expect(await steps()).toBeInTheDocument();
  });

  it("sends anonymous visitors to sign in (the page)", async () => {
    window.history.pushState({}, "", `/steward/assets/${ASSET_ID}/ipo`);
    const backend = fakeBackend({ "GET /world": () => json(WORLD) });
    const layer = createDataLayer({ baseUrl: BASE, fetch: backend.fetch });
    render(
      <WorldProvider dataLayer={layer}>
        <PrototypeProvider>
          {await IpoPage({ params: Promise.resolve({ id: ASSET_ID }) })}
        </PrototypeProvider>
      </WorldProvider>,
    );

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent(`/steward/assets/${ASSET_ID}/ipo`)}`,
      ),
    );
    expect(backend.calls(PREVIEW)).toBe(0);
  });
});
