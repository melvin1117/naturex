import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import IpoPage from "@/app/sandbox/steward/assets/[id]/ipo/page";
import { IpoLaunchScreen } from "@/components/ipo-launch-screen";
import { WorldProvider } from "@/components/world-provider";
import type {
  AssetDetail,
  IpoOut,
  IpoPreview,
  WorldOut,
} from "@/lib/api/types";
import { createDataLayer, queryKeys } from "@/lib/data-layer";
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
    // A sandbox listing: verification doesn't hold the offer back.
    verification: {
      level: "unverified",
      in_review: false,
      required: false,
      decision: null,
      decided_at: null,
      reason: null,
      run_id: null,
    },
    ...overrides,
  };
}

const LIVE_VERIFIED: IpoPreview["verification"] = {
  level: "verified",
  in_review: false,
  required: false,
  decision: "verified",
  decided_at: "2026-10-20T15:00:00Z",
  reason: "Signed.",
  run_id: "77777777-7777-4777-8777-777777777777",
};
const LIVE_NEEDED: IpoPreview["verification"] = {
  level: "unverified",
  in_review: false,
  required: true,
  decision: null,
  decided_at: null,
  reason: null,
  run_id: null,
};

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
      <IpoLaunchScreen assetId={ASSET_ID} />
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

describe("IpoLaunchScreen", () => {
  it("shows every term of the backend's price formula, labelled", async () => {
    const { backend } = renderLaunch();

    const list = await steps();
    const text = list.textContent ?? "";
    expect(text).toContain("$1,234,567.00/yr");
    expect(text).toContain("× 10");
    expect(text).toContain("0.5 + 0.5 × health/100, health 78.4");
    expect(text).toContain("× 0.892");
    expect(text).toContain("0.7 + 0.3 × confidence/100, confidence 85");
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
    expect(shares).toHaveValue("2,000,000");
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
      screen.getByText("Opening price · play money").parentElement,
    ).toHaveTextContent("$10.5173 per unit");
    expect(
      screen.getByRole("img", {
        name: "Your community keeps 51% of the stake; 49% is on offer to supporters.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /See it on the Marketplace/ }),
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
      /A WildWorth reviewer approves them before the offer opens/,
    ],
    [
      "not_verified",
      /A WildWorth reviewer approves them before the offer opens/,
    ],
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

  it("loads in the screen's shape, then the offer, without a spinner (#219)", async () => {
    renderLaunch();
    expect(window.document.querySelector("[data-skeleton=ipo]")).not.toBeNull();
    expect(window.document.querySelector(".animate-spin")).toBeNull();
    await steps();
    expect(window.document.querySelector("[data-skeleton]")).toBeNull();
  });

  it("links to the field evidence screen, which can raise the confidence (#214)", async () => {
    renderLaunch();
    await steps();

    expect(
      screen.getByRole("link", { name: "Add field photos" }),
    ).toHaveAttribute("href", `/steward/assets/${ASSET_ID}/evidence`);
    expect(
      screen.getByText(/field photos of the land can raise the next rating/i),
    ).toBeVisible();
  });

  it("links the rating behind the price to its Agent Trace", async () => {
    const run = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const rated = unlaunched();
    renderLaunch({
      [ASSET]: () =>
        json({
          ...rated,
          latest_report: { ...rated.latest_report!, run_id: run },
        }),
    });
    await steps();
    expect(
      screen.getByRole("link", { name: "See how the AI rated it" }),
    ).toHaveAttribute("href", `/trace/${run}`);
  });

  it("links a listing that needs verification to its verification screen", async () => {
    renderLaunch({
      [PREVIEW]: (request) =>
        previewFor(request, {
          launchable: false,
          blocked_reason: "not_verified",
        }),
    });
    await steps();

    // The blocker comes first (#216): the checklist above the offer, not an alert under it.
    const checklist = await screen.findByRole("region", {
      name: "Before you open to supporters",
    });
    const items = within(checklist).getAllByRole("listitem");
    expect(items.map((li) => li.dataset.state)).toEqual([
      "done",
      "current",
      "upcoming",
    ]);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[1]).toHaveTextContent("Documents verified · Needed");
    expect(
      within(items[1]!).getByRole("link", { name: "Verify this listing" }),
    ).toHaveAttribute("href", `/steward/assets/${ASSET_ID}/verify`);
    expect(items[2]).toHaveTextContent(
      "Open to supporters · After verification",
    );
    expect(
      checklist.compareDocumentPosition(
        screen.getByRole("region", { name: /Opening price/ }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The offer stays editable as a preview; the old alert under the price is gone.
    expect(
      screen.getByRole("heading", { name: "Opening price Preview" }),
    ).toBeVisible();
    expect(screen.queryByText("Verification comes first")).toBeNull();
    expect(
      screen.getByText(/You can open it once the land documents are verified/),
    ).toBeVisible();
    expect(screen.getByLabelText("Units to issue")).toBeEnabled();
    expect(launchButton()).toBeDisabled();
  });

  it("never calls a live listing a sandbox: verified, it's done and ready", async () => {
    renderLaunch({
      [PREVIEW]: (request) =>
        previewFor(request, { verification: LIVE_VERIFIED }),
    });
    await steps();
    const checklist = screen.getByRole("region", {
      name: "Before you open to supporters",
    });
    expect(checklist).not.toHaveTextContent(/sandbox/i);
    const items = within(checklist).getAllByRole("listitem");
    expect(items.map((li) => li.dataset.state)).toEqual([
      "done",
      "done",
      "current",
    ]);
    expect(items[1]).toHaveTextContent(
      /approved the land documents on 20 Oct 2026/,
    );
    await waitFor(() => expect(launchButton()).toBeEnabled());
  });

  it("follows the newer preview after an approval: Ready with Launch, never After verification", async () => {
    renderLaunch({
      [PREVIEW]: sequence(
        (request) =>
          previewFor(request, {
            launchable: false,
            blocked_reason: "not_verified",
            verification: LIVE_NEEDED,
          }),
        (request) => previewFor(request, { verification: LIVE_VERIFIED }),
      ),
    });
    await steps();
    expect(
      screen.getByRole("region", { name: "Before you open to supporters" }),
    ).toHaveTextContent("Open to supporters · After verification");
    expect(launchButton()).toBeDisabled();

    // The reviewer approves: the listing's status event refetches the preview.
    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("listing_status", 1, {
        asset_id: ASSET_ID,
        transition: "verification",
        level: "verified",
      });
    });
    await waitFor(() => expect(launchButton()).toBeEnabled());
    const checklist = screen.getByRole("region", {
      name: "Before you open to supporters",
    });
    expect(checklist).toHaveTextContent("Open to supporters · Ready");
    expect(checklist).not.toHaveTextContent("After verification");
    expect(checklist).not.toHaveTextContent(/sandbox/i);
  });

  it("shows a launchable sandbox offer as ready, with verification optional", async () => {
    renderLaunch();
    await steps();

    const checklist = screen.getByRole("region", {
      name: "Before you open to supporters",
    });
    const items = within(checklist).getAllByRole("listitem");
    expect(items.map((li) => li.dataset.state)).toEqual([
      "done",
      "optional",
      "current",
    ]);
    expect(items[0]).toHaveTextContent(/Rated · Done/);
    expect(
      within(items[1]!).getByRole("link", { name: "Verify anyway" }),
    ).toHaveAttribute("href", `/steward/assets/${ASSET_ID}/verify`);
    expect(items[2]).toHaveTextContent("Open to supporters · Ready");
    expect(
      screen.getByRole("heading", { name: "Opening price" }),
    ).toBeVisible();
    expect(screen.getByText("Opening offer")).toBeVisible();
    expect(screen.queryByText(/\(IPO\)/)).toBeNull();
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
  ])(
    "explains a launch refused with %s, focused, until a newer preview",
    async (code, message) => {
      renderLaunch({ [LAUNCH]: () => refused(409, code) });
      await steps();
      await confirmLaunch();

      const alert = (await screen.findByText(message)).closest("[role=alert]");
      await waitFor(() => expect(alert).toHaveFocus());
      expect(screen.getByLabelText("Units to issue")).toBeEnabled();
      // Not again until the owner checks: the refusal is newer than the preview.
      expect(launchButton()).toBeDisabled();

      // The newer preview says it would go ahead now: the refusal goes.
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() =>
        expect(screen.queryByText(message)).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(launchButton()).toBeEnabled());
    },
  );

  it("keeps a launch refusal the newer preview agrees with, once", async () => {
    renderLaunch({
      [PREVIEW]: sequence(
        (request) => previewFor(request),
        (request) =>
          previewFor(request, {
            launchable: false,
            blocked_reason: "run_in_progress",
          }),
      ),
      [LAUNCH]: () => refused(409, "run_in_progress"),
    });
    await steps();
    await confirmLaunch();
    await screen.findByText("A rating is running");

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(screen.getAllByText("A rating is running")).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getAllByText("A rating is running")).toHaveLength(1);
    expect(launchButton()).toBeDisabled();
  });

  it("clears a launch refusal when the offer changes", async () => {
    renderLaunch({ [LAUNCH]: () => refused(409, "ipo_price_too_high") });
    await steps();
    await confirmLaunch();
    await screen.findByText(/Issue more units/);

    fireEvent.change(screen.getByLabelText("Units to issue"), {
      target: { value: "2000000" },
    });
    expect(screen.queryByText(/Issue more units/)).not.toBeInTheDocument();
    await waitFor(() => expect(launchButton()).toBeEnabled());
  });

  it("explains a launch that fails for another reason until the offer changes", async () => {
    renderLaunch({ [LAUNCH]: () => json({}, { status: 500 }) });
    await steps();
    await confirmLaunch();

    const title = await screen.findByText("The opening offer didn't launch");
    await waitFor(() => expect(title.closest("[role=alert]")).toHaveFocus());
    // The owner may try again straight away.
    expect(launchButton()).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Community keeps"), {
      target: { value: "52" },
    });
    expect(
      screen.queryByText("The opening offer didn't launch"),
    ).not.toBeInTheDocument();
  });

  it("locks the offer while the launch is in flight", async () => {
    let finish: (response: Response) => void = () => {};
    renderLaunch({
      [LAUNCH]: () => new Promise<Response>((resolve) => (finish = resolve)),
    });
    await steps();
    await confirmLaunch();

    await waitFor(() =>
      expect(screen.getByLabelText("Units to issue")).toBeDisabled(),
    );
    expect(screen.getByLabelText("Community keeps")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Launching/ })).toBeDisabled();
    finish(json(launched(), { status: 201 }));
    await screen.findByText(/is open to supporters/);
  });

  it("posts once on a double click or a repeated Enter", async () => {
    const { backend } = renderLaunch();
    await steps();
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", {
      name: /^Launch at .* per unit$/,
    });
    const form = submit.closest("form")!;
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(form);
    // The trigger is disabled while the launch runs.
    const trigger = screen.getByRole("button", { name: /Launching/ });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);

    await screen.findByText(/is open to supporters/);
    expect(backend.calls(LAUNCH)).toBe(1);
  });

  it("confirms the preview it showed when a newer one arrives meanwhile", async () => {
    const { backend } = renderLaunch({
      [PREVIEW]: sequence(
        () => json(preview()),
        () => json(preview({ ipo_price: "11.0021" })),
      ),
      [LAUNCH]: () => refused(409, "ipo_price_changed"),
    });
    await steps();
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    const dialog = await screen.findByRole("dialog");

    // A rating run ends while the dialog is open: the preview refetches.
    const source = FakeEventSource.latest();
    act(() => source.open());
    act(() =>
      source.emit("rating_progress", 1, {
        asset_id: ASSET_ID,
        step: "done",
        status: "succeeded",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("ipo-price")).toHaveTextContent("$11.0021"),
    );
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("$10.5173");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /^Launch at \$10\.5173/ }),
    );

    expect(
      await screen.findByText("The opening price changed"),
    ).toBeInTheDocument();
    const post = backend.requests.find((r) => r.method === "POST")!;
    expect((await post.json()).expected_price).toBe("10.5173");
  });

  it("refetches the preview when the site's rating run ends", async () => {
    const { backend } = renderLaunch();
    await steps();
    const before = backend.calls(PREVIEW);
    const source = FakeEventSource.latest();
    act(() => source.open());
    act(() =>
      source.emit("rating_progress", 1, {
        asset_id: ASSET_ID,
        step: "done",
        status: "succeeded",
      }),
    );
    await waitFor(() => expect(backend.calls(PREVIEW)).toBe(before + 1));
  });

  it("refetches the asset after the launch, which is now trading", async () => {
    const { backend, layer } = renderLaunch({
      [ASSET]: sequence(
        () => json(unlaunched()),
        () =>
          json(
            assetFixture({
              name: "Río Claro Forest",
              trading: true,
              ipo_at: "2026-10-19T00:00:00Z",
            }),
          ),
      ),
    });
    await steps();
    const before = backend.calls(ASSET);
    await confirmLaunch();
    await screen.findByText(/is open to supporters/);

    await waitFor(() => expect(backend.calls(ASSET)).toBe(before + 1));
    await waitFor(() =>
      expect(
        layer.cache.getState<AssetDetail>(queryKeys.asset(ASSET_ID)).data
          ?.trading,
      ).toBe(true),
    );
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
        screen.getByRole("link", { name: /See it on the Marketplace/ }),
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
        <IpoLaunchScreen assetId="not-a-uuid" />
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
