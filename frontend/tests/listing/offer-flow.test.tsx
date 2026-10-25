import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OfferStep } from "@/components/listing/offer-step";
import { ProveStep } from "@/components/listing/prove-step";
import { Toaster } from "@/components/ui/sonner";
import { OfferList } from "@/components/verification/offer-list";
import { WorldProvider } from "@/components/world-provider";
import type {
  AssetDetail,
  IpoPreview,
  PendingOffer,
  WorldOut,
} from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";

import { stubBrowserApis } from "../exchange/render";
import {
  ADMIN_WORLD,
  BASE,
  createFakeEventSource,
  fakeBackend,
  json,
  SIGNED_IN_WORLD,
} from "../lib/helpers";
import { asset as assetFixture, ASSET_ID } from "../trade/fixtures";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/steward/list",
  useSearchParams: () => new URLSearchParams(),
}));

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

function preview(overrides: Partial<IpoPreview> = {}): IpoPreview {
  return {
    asset_id: ASSET_ID,
    report_id: "88888888-8888-4888-8888-888888888888",
    report_version: 3,
    formula: "x",
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

/** Echo the offering asked for, as the backend does. */
function previewFor(request: Request) {
  const url = new URL(request.url);
  const total = Number(url.searchParams.get("total_shares"));
  const retained = Number(url.searchParams.get("retained_pct") ?? "51");
  return json(
    preview({
      total_shares: total,
      retained_pct: retained.toFixed(2),
      shares_offered: Math.floor(total * (1 - retained / 100)),
      retained_shares: total - Math.floor(total * (1 - retained / 100)),
    }),
  );
}

type Routes = Parameters<typeof fakeBackend>[0];

function renderWith(
  ui: ReactNode,
  routes: Routes,
  world: WorldOut = SIGNED_IN_WORLD,
) {
  const backend = fakeBackend({ "GET /world": () => json(world), ...routes });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      {ui}
      <Toaster />
    </WorldProvider>,
  );
  return backend;
}

const PREVIEW = `GET /assets/${ASSET_ID}/ipo/preview`;
const SEND = `POST /assets/${ASSET_ID}/offer`;

beforeAll(stubBrowserApis);
beforeEach(() => nav.push.mockReset());

describe("the Offer step (ADR-0008 §5)", () => {
  it("sends the community's terms at the price the rating sets", async () => {
    const backend = renderWith(<OfferStep asset={unlaunched()} />, {
      [PREVIEW]: previewFor,
      [SEND]: () => json({ ...preview(), sent_at: "2026-10-25T10:00:00Z" }),
    });
    expect(
      await screen.findByRole("heading", { name: "Set your offer" }),
    ).toBeVisible();
    // The price is the backend's preview, never the browser's.
    expect(await screen.findAllByText("$10.5173")).not.toHaveLength(0);
    const send = screen.getByRole("button", { name: /Send for review/ });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    await waitFor(() => expect(backend.calls(SEND)).toBe(1));
    const body = (await backend.requests
      .find((r) => r.method === "POST")!
      .clone()
      .json()) as Record<string, unknown>;
    expect(body).toEqual({
      total_shares: 1_000_000,
      retained_pct: "51",
      expected_price: "10.5173",
    });
  });

  it("waits for the Reviewer once sent, and leads to their side", async () => {
    renderWith(
      <OfferStep
        asset={unlaunched({
          offer: {
            total_shares: 2_000_000,
            retained_pct: "60.00",
            sent_at: "2026-10-25T10:00:00Z",
            review_note: null,
          },
        })}
      />,
      {
        [PREVIEW]: previewFor,
        "POST /demo/persona": () =>
          json({
            ...ADMIN_WORLD,
            me: { ...ADMIN_WORLD.me!, persona: "admin" },
          }),
      },
    );
    expect(
      await screen.findByRole("heading", { name: "Waiting for the Reviewer" }),
    ).toBeVisible();
    expect(screen.getByText("2,000,000")).toBeVisible();
    expect(screen.getByText("60%")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /Review it as the Reviewer/ }),
    );
    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith("/admin/verifications"),
    );
  });

  it("shows the Reviewer's note on an offer sent back, with its terms to change", async () => {
    renderWith(
      <OfferStep
        asset={unlaunched({
          offer: {
            total_shares: 2_000_000,
            retained_pct: "40.00",
            sent_at: null,
            review_note: "Keep at least half of the units.",
          },
        })}
      />,
      { [PREVIEW]: previewFor },
    );
    expect(
      await screen.findByText(/Keep at least half of the units\./),
    ).toBeVisible();
    expect(screen.getByLabelText("Units to issue")).toHaveValue("2,000,000");
    expect(screen.getByLabelText("Community keeps")).toHaveValue("40");
  });

  it("says where the site is once the Reviewer approved it", async () => {
    renderWith(
      <OfferStep
        asset={unlaunched({ ipo_at: "2026-10-25T11:00:00Z", trading: true })}
      />,
      {},
    );
    expect(
      await screen.findByRole("heading", {
        name: "Río Claro Forest is on the Marketplace",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /See it on the Marketplace/ }),
    ).toHaveAttribute("href", `/asset/${ASSET_ID}`);
  });
});

describe("the Prove step", () => {
  it("can be skipped: documents are optional in the sandbox", async () => {
    const onContinue = vi.fn();
    renderWith(<ProveStep asset={unlaunched()} onContinue={onContinue} />, {
      [`GET /assets/${ASSET_ID}/verification/runs`]: () => json([]),
    });
    expect(
      await screen.findByRole("heading", { name: "Show it's yours" }),
    ).toBeVisible();
    expect(screen.getByText(/this step is optional/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Skip for now/ }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});

const pending = (overrides: Partial<PendingOffer> = {}): PendingOffer => ({
  ...preview(),
  sent_at: "2026-10-25T10:00:00Z",
  asset_name: "Río Claro Forest",
  community_name: "Río Claro Community",
  area_ha: "412.00",
  grade: "AA",
  ...overrides,
});

describe("the Reviewer's offers", () => {
  const APPROVE = `POST /admin/assets/${ASSET_ID}/offer/approve`;
  const BACK = `POST /admin/assets/${ASSET_ID}/offer/send-back`;

  it("approves an offer, which puts the site on the Marketplace", async () => {
    let waiting = [pending()];
    const backend = renderWith(
      <OfferList />,
      {
        "GET /admin/offers": () => json(waiting),
        [APPROVE]: () => {
          waiting = [];
          return json({ ...preview(), launched_at: "2026-10-25T11:00:00Z" });
        },
      },
      ADMIN_WORLD,
    );
    const list = await screen.findByRole("list", {
      name: "Offers waiting for review",
    });
    const row = within(list).getByRole("listitem");
    expect(
      within(row).getByText("Río Claro Community", { exact: false }),
    ).toBeVisible();
    expect(within(row).getByText("$10.5173")).toBeVisible();
    expect(within(row).getByText("490,000")).toBeVisible();
    expect(within(row).getByText("No documents (optional here)")).toBeVisible();

    fireEvent.click(
      within(row).getByRole("button", { name: /Approve and list/ }),
    );

    expect(
      await screen.findByText("Río Claro Forest is on the Marketplace"),
    ).toBeVisible();
    expect(backend.calls(APPROVE)).toBe(1);
    expect(await screen.findByText(/No offer is waiting/)).toBeVisible();
  });

  it("sends an offer back with a note for its community", async () => {
    const backend = renderWith(
      <OfferList />,
      {
        "GET /admin/offers": () => json([pending()]),
        [BACK]: () =>
          json({
            total_shares: 1_000_000,
            retained_pct: "51.00",
            sent_at: null,
            review_note: "Keep more units.",
          }),
      },
      ADMIN_WORLD,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Send back/ }));
    const dialog = await screen.findByRole("dialog");
    const send = within(dialog).getByRole("button", { name: "Send back" });
    expect(send).toBeDisabled();
    fireEvent.change(
      within(dialog).getByLabelText("What should they change?"),
      {
        target: { value: "  Keep more units. " },
      },
    );
    fireEvent.click(send);

    await waitFor(() => expect(backend.calls(BACK)).toBe(1));
    const body = (await backend.requests
      .find((r) => r.url.endsWith("/send-back"))!
      .clone()
      .json()) as Record<string, unknown>;
    expect(body).toEqual({ note: "Keep more units." });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
