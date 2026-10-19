import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TradePanel } from "@/components/trade-panel";
import { WorldProvider } from "@/components/world-provider";
import type { WorldOut } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  SIGNED_IN_WORLD,
  WORLD,
} from "../lib/helpers";
import { ASSET_ID, asset, holding, portfolio, quoteFor } from "./fixtures";

vi.mock("next/navigation", () => ({
  usePathname: () => `/asset/${ASSET_ID}`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const ASSET = `GET /assets/${ASSET_ID}`;
const QUOTE = `GET /assets/${ASSET_ID}/quote`;
const ORDER = "POST /orders";

const filled = (side: "buy" | "sell", qty: number) => ({
  id: "66666666-6666-4666-8666-666666666666",
  asset_id: ASSET_ID,
  side,
  qty,
  fill_price: side === "buy" ? "20.0200" : "19.9800",
  total: side === "buy" ? "200.20" : "99.90",
  primary_qty: side === "buy" ? qty : 0,
  community_amount: side === "buy" ? "200.20" : "0.00",
  is_primary: side === "buy",
  created_at: "2026-10-18T00:00:00Z",
});

type Routes = Parameters<typeof fakeBackend>[0];

function renderPanel(routes: Routes = {}, world: WorldOut = SIGNED_IN_WORLD) {
  const backend = fakeBackend({
    "GET /world": () => json(world),
    [ASSET]: () => json(asset()),
    "GET /portfolio": () => json(portfolio()),
    [QUOTE]: (request) => quoteFor(request),
    [ORDER]: () => json(filled("buy", 10)),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  const utils = render(
    <WorldProvider dataLayer={layer}>
      <TradePanel assetId={ASSET_ID} />
    </WorldProvider>,
  );
  return { ...utils, backend, layer };
}

const units = () => screen.getByLabelText("Units");
const buyButton = () => screen.getByRole("button", { name: /^Buy .*units$/ });

async function quoted(total = "$200.20") {
  await waitFor(() =>
    expect(screen.getByLabelText("Quote")).toHaveTextContent(total),
  );
}

beforeEach(() => FakeEventSource.reset());

describe("TradePanel", () => {
  it("asks anonymous visitors to sign in and come back here", async () => {
    const { backend } = renderPanel({}, WORLD);

    const link = await screen.findByRole("link", { name: /sign in to trade/i });
    expect(link).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(`/asset/${ASSET_ID}`)}`,
    );
    expect(screen.queryByLabelText("Units")).not.toBeInTheDocument();
    expect(backend.calls("GET /portfolio")).toBe(0);
    expect(backend.calls(QUOTE)).toBe(0);
  });

  it.each([
    [{ status: "suspended" as const }, /paused/],
    [{ price: null }, /opening offer/],
    [{ status: "rating" as const }, /opening offer/],
  ])("locks trading for %o", async (overrides, message) => {
    renderPanel({ [ASSET]: () => json(asset(overrides)) });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByLabelText("Units")).not.toBeInTheDocument();
  });

  it("tells admins they can't trade", async () => {
    renderPanel(
      {},
      {
        ...SIGNED_IN_WORLD,
        me: { ...SIGNED_IN_WORLD.me!, is_admin: true },
      },
    );

    expect(
      await screen.findByText(/Admin accounts can't trade/),
    ).toBeInTheDocument();
  });

  it("shows the balance and the backend's quote before confirming", async () => {
    const { backend } = renderPanel();

    expect(await screen.findByText("$10,000.00 available")).toBeInTheDocument();
    await quoted();
    const quote = screen.getByLabelText("Quote");
    expect(quote).toHaveTextContent("Price per unit$20.00");
    expect(quote).toHaveTextContent("(+0.10%)");
    expect(quote).toHaveTextContent("Fill price incl. slippage (+0.10%)$20.02");
    expect(quote).toHaveTextContent("To the community fund$200.20");
    const request = backend.requests.find((r) => r.url.includes("/quote"))!;
    expect(new URL(request.url).searchParams.toString()).toBe(
      "side=buy&qty=10",
    );
    expect(buyButton()).toBeEnabled();
  });

  it("keeps units a positive whole number", async () => {
    renderPanel();
    await quoted();

    fireEvent.change(units(), { target: { value: "1.5e3" } });
    expect(units()).toHaveValue("153");
    fireEvent.change(units(), { target: { value: "0" } });

    expect(units()).toHaveAttribute("aria-invalid", "true");
    expect(units()).toHaveAccessibleDescription(
      "Enter a whole number of units, 1 or more.",
    );
    expect(buyButton()).toBeDisabled();
  });

  it("refuses a buy that costs more than the available cash", async () => {
    renderPanel({
      "GET /portfolio": () => json(portfolio({ cash_balance: "150.00" })),
    });
    await quoted();

    expect(units()).toHaveAccessibleDescription(
      "That costs $200.20; you have $150.00 available.",
    );
    expect(buyButton()).toBeDisabled();
  });

  it("refuses a sell of more units than held", async () => {
    renderPanel({
      "GET /portfolio": () =>
        json(portfolio({ holdings: [holding({ shares: 5 })] })),
    });
    const sellTab = await screen.findByRole("tab", { name: "Sell units" });
    await waitFor(() => expect(sellTab).toBeEnabled());
    fireEvent.mouseDown(sellTab);
    fireEvent.click(sellTab);

    await waitFor(() =>
      expect(units()).toHaveAccessibleDescription(
        "You hold 5 units of this site.",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Sell 10 units" }),
    ).toBeDisabled();
  });

  it("disables Sell with nothing held", async () => {
    renderPanel();

    expect(
      await screen.findByRole("tab", { name: "Sell units" }),
    ).toBeDisabled();
  });

  it("fills Max from the backend's largest order", async () => {
    renderPanel();
    await quoted();

    fireEvent.click(screen.getByRole("button", { name: "Max" }));

    expect(units()).toHaveValue("499");
  });

  it("places the order once, announces it and refreshes the balance", async () => {
    let cash = "10000.00";
    const { backend } = renderPanel({
      "GET /portfolio": () => json(portfolio({ cash_balance: cash })),
      [ORDER]: () => {
        cash = "9799.80";
        return json(filled("buy", 10));
      },
    });
    await quoted();

    fireEvent.click(buyButton());

    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent(
        "Bought 10 units at $20.02 each. You paid $200.20.",
      ),
    );
    expect(backend.calls(ORDER)).toBe(1);
    const body = (await backend.requests
      .find((r) => r.method === "POST")!
      .json()) as unknown;
    expect(body).toEqual({ asset_id: ASSET_ID, side: "buy", qty: 10 });
    expect(await screen.findByText("$9,799.80 available")).toBeInTheDocument();
    expect(
      screen.getByText(/went straight to the community/),
    ).toHaveTextContent(
      "10 opening units: $200.20 went straight to the community",
    );
  });

  it("never submits twice while an order is pending", async () => {
    let release: (response: Response) => void = () => undefined;
    const { backend } = renderPanel({
      [ORDER]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await quoted();
    const form = units().closest("form")!;

    // Two submits in the same tick: the ref stops the second before React re-renders.
    fireEvent.submit(form);
    fireEvent.submit(form);
    const pending = await screen.findByRole("button", { name: "Buying…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    fireEvent.submit(form);
    expect(backend.calls(ORDER)).toBe(1);
    await act(async () => release(json(filled("buy", 10))));
    await screen.findByText(/Stake added/);
    expect(backend.calls(ORDER)).toBe(1);
  });

  it.each([
    [401, "auth_required", /session has ended/, "Sign in again"],
    [403, "insider_trading_blocked", /community can't trade its units/, null],
    [403, "admins_cannot_trade", /Admin accounts can't trade/, null],
    [409, "not_trading", /hasn't opened yet/, null],
    [409, "insufficient_cash", /enough play money/, null],
    [409, "insufficient_shares", /more units than you hold/, null],
    [409, "insufficient_supply", /Not enough units are available/, null],
    [409, "Asset is not listed for trading", /isn't open for trading/, null],
    [400, "order_too_large", /too large/, null],
    [
      422,
      [{ loc: ["body", "qty"], msg: "bad" }],
      /whole number of units/,
      null,
    ],
    [500, "boom", /couldn't confirm your order/, "Check your stakes"],
  ])(
    "explains a %i %j and never replays the order",
    async (status, detail, message, link) => {
      const { backend } = renderPanel({
        [ORDER]: () => json({ detail }, { status }),
      });
      await quoted();

      fireEvent.click(buyButton());

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert).toHaveTextContent(message));
      if (link)
        expect(within(alert).getByRole("link", { name: link })).toBeVisible();
      expect(backend.calls(ORDER)).toBe(1);
    },
  );

  it("says when to retry after a 429", async () => {
    renderPanel({
      [ORDER]: () =>
        json(
          { detail: "too_many_orders" },
          { status: 429, headers: { "Retry-After": "30" } },
        ),
    });
    await quoted();

    fireEvent.click(buyButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Too many requests. Try again in 30 seconds.",
      ),
    );
  });

  it("warns that a lost answer may still have filled", async () => {
    const { backend } = renderPanel({
      [ORDER]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await quoted();

    fireEvent.click(buyButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /couldn't confirm your order.*may have gone through/,
      ),
    );
    expect(backend.calls(ORDER)).toBe(1);
  });

  it("shows a quote failure on the units field", async () => {
    renderPanel({
      [QUOTE]: () => json({ detail: "order_too_large" }, { status: 400 }),
    });

    await waitFor(() =>
      expect(units()).toHaveAccessibleDescription(
        "That order is too large. Try fewer units.",
      ),
    );
    expect(buyButton()).toBeDisabled();
  });

  it("re-quotes when the price ticks", async () => {
    let price = "20.0000";
    const { backend } = renderPanel({
      [ASSET]: () => json(asset({ price })),
      [QUOTE]: (request) => quoteFor(request, { price }),
    });
    await quoted();
    const before = backend.calls(QUOTE);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    price = "21.5000";
    act(() => {
      FakeEventSource.latest().open();
      FakeEventSource.latest().emit("price_tick", 1, {
        asset_id: ASSET_ID,
        price,
        reason: "tick",
      });
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Quote")).toHaveTextContent(
        "Price per unit$21.50",
      ),
    );
    expect(backend.calls(QUOTE)).toBeGreaterThan(before);
  });
});
