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
  sequence,
  SIGNED_IN_WORLD,
  WORLD,
} from "../lib/helpers";
import { ASSET_ID, asset, holding, portfolio, quoteFor } from "./fixtures";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => `/asset/${ASSET_ID}`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
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
  cash_balance: side === "buy" ? "9799.80" : "10099.90",
  shares_held: side === "buy" ? 10 : 0,
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

beforeEach(() => {
  FakeEventSource.reset();
  nav.search = "";
});

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

  it("keeps the query string in the sign-in link", async () => {
    nav.search = "asset=abc&tab=trade";
    renderPanel({}, WORLD);

    const link = await screen.findByRole("link", { name: /sign in to trade/i });
    expect(link).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(`/asset/${ASSET_ID}?asset=abc&tab=trade`)}`,
    );
  });

  it.each([
    [{ status: "suspended" as const }, /paused/],
    [{ price: null }, /opening offer/],
    [{ status: "rating" as const }, /opening offer/],
    [{ trading: false, ipo_at: null }, /isn't trading yet/],
  ])("locks trading for %o", async (overrides, message) => {
    const { backend } = renderPanel({ [ASSET]: () => json(asset(overrides)) });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByLabelText("Units")).not.toBeInTheDocument();
    expect(backend.calls(QUOTE)).toBe(0);
  });

  it("shows no unit counts before the opening offer (T59)", async () => {
    renderPanel({
      [ASSET]: () =>
        json(
          asset({
            trading: false,
            ipo_at: null,
            price: null,
            total_shares: null,
            retained_pct: null,
            primary_shares_remaining: 0,
          }),
        ),
    });

    expect(await screen.findByText(/isn't trading yet/)).toBeInTheDocument();
    expect(screen.getByText("Set at the opening offer")).toBeInTheDocument();
    expect(screen.queryByText(/^of /)).not.toBeInTheDocument();
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

  it("explains a quote's trade block and never offers the order", async () => {
    renderPanel({
      [QUOTE]: (request) =>
        quoteFor(request, {
          max_qty: 0,
          trade_blocked_reason: "insider_trading_blocked",
        }),
    });

    expect(
      await screen.findByText(/Members of this site's community can't trade/),
    ).toBeInTheDocument();
    expect(buyButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Max" })).toBeDisabled();
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
    expect(buyButton()).not.toHaveAttribute("aria-disabled");
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
    expect(buyButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("refuses a buy that costs more than the available cash", async () => {
    renderPanel({
      "GET /portfolio": () => json(portfolio({ cash_balance: "150.00" })),
    });
    await quoted();

    expect(units()).toHaveAccessibleDescription(
      "You have $150.00 of play money. This needs $200.20.",
    );
    expect(buyButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("says how many units the cash covers, and fixes the order in one tap", async () => {
    // The backend's own largest order for this account (cash, supply, size cap).
    renderPanel({
      "GET /portfolio": () => json(portfolio({ cash_balance: "150.00" })),
      [QUOTE]: (request) =>
        quoteFor(request, {
          max_qty: 7,
          ...(new URL(request.url).searchParams.get("qty") === "7" && {
            total: "140.14",
          }),
        }),
    });
    await quoted();

    expect(units()).toHaveAccessibleDescription(
      "You have $150.00 of play money. This needs $200.20. You can buy up to 7 units now.",
    );
    const fix = screen.getByRole("button", { name: "Change to 7 units" });
    fix.focus();
    fireEvent.click(fix);

    expect(units()).toHaveValue("7");
    // The fix goes away with the problem; focus moves to the field it changed, not the page.
    expect(units()).toHaveFocus();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Buy 7 units" }),
      ).not.toHaveAttribute("aria-disabled"),
    );
    expect(
      screen.queryByRole("button", { name: /^Change to/ }),
    ).not.toBeInTheDocument();
  });

  it("asks a 1-unit quote how much would go through when the size is refused", async () => {
    const { backend } = renderPanel({
      [QUOTE]: (request) =>
        new URL(request.url).searchParams.get("qty") === "1"
          ? quoteFor(request, { max_qty: 279, max_order_qty: 10_000 })
          : json({ detail: "order_too_large" }, { status: 400 }),
    });
    fireEvent.change(await screen.findByLabelText("Units"), {
      target: { value: "999999999" },
    });

    await waitFor(() =>
      expect(units()).toHaveAccessibleDescription(
        "One order can be at most 10,000 units. You can buy up to 279 units now.",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Change to 279 units" }),
    );
    expect(units()).toHaveValue("279");
    expect(
      backend.requests.some(
        (r) => new URL(r.url).searchParams.get("qty") === "1",
      ),
    ).toBe(true);
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
    ).toHaveAttribute("aria-disabled", "true");
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
        "Bought 10 units at $20.02 each. You paid $200.20. Play money now $9,799.80; 10 units held. You now hold a stake in this site.",
      ),
    );
    expect(backend.calls(ORDER)).toBe(1);
    const body = (await backend.requests
      .find((r) => r.method === "POST")!
      .json()) as unknown;
    // The quoted total caps the fill: a worse price is refused, not filled.
    expect(body).toEqual({
      asset_id: ASSET_ID,
      side: "buy",
      qty: 10,
      max_total: "200.20",
    });
    expect(await screen.findByText("$9,799.80 available")).toBeInTheDocument();
    expect(
      screen.getByText(/went straight to the community/),
    ).toHaveTextContent(
      "10 opening units: $200.20 went straight to the community",
    );
  });

  it("shows the balance and holding the order returned, not the cached portfolio", async () => {
    // The portfolio refetch is slow and still answers with the old balance.
    renderPanel({
      "GET /portfolio": sequence(
        () => json(portfolio({ cash_balance: "10000.00" })),
        () => new Promise<Response>(() => undefined),
      ),
      [ORDER]: () =>
        json({
          ...filled("buy", 10),
          cash_balance: "9799.80",
          shares_held: 15,
        }),
    });
    await quoted();

    const submit = buyButton();
    submit.focus();
    fireEvent.click(submit);

    const receipt = (await screen.findByText(/Stake added/)).parentElement!;
    // The button stays focusable (aria-disabled) through the order: focus never drops, and
    // the status line announces the fill once (the receipt itself isn't a focus target).
    expect(submit).toHaveFocus();
    expect(receipt).not.toHaveAttribute("tabindex");
    expect(
      within(receipt).getByText("Play money now").nextSibling,
    ).toHaveTextContent("$9,799.80");
    expect(
      within(receipt).getByText("Units held").nextSibling,
    ).toHaveTextContent("15");
  });

  it("sends the quoted proceeds as the floor of a sell", async () => {
    const { backend } = renderPanel({
      "GET /portfolio": () =>
        json(portfolio({ holdings: [holding({ shares: 5 })] })),
      [ORDER]: () => json(filled("sell", 5)),
    });
    const sellTab = await screen.findByRole("tab", { name: "Sell units" });
    await waitFor(() => expect(sellTab).toBeEnabled());
    fireEvent.mouseDown(sellTab);
    fireEvent.change(units(), { target: { value: "5" } });
    const sell = await screen.findByRole("button", { name: "Sell 5 units" });
    await waitFor(() => expect(sell).not.toHaveAttribute("aria-disabled"));

    fireEvent.click(sell);

    await screen.findByText(/Stake reduced/);
    const body = (await backend.requests
      .find((r) => r.method === "POST")!
      .json()) as unknown;
    expect(body).toEqual({
      asset_id: ASSET_ID,
      side: "sell",
      qty: 5,
      min_total: "99.90",
    });
  });

  it("can't confirm while the quote is being refreshed", async () => {
    let release: (response: Response) => void = () => undefined;
    let slow = false;
    const { backend, layer } = renderPanel({
      [QUOTE]: (request) =>
        slow
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : quoteFor(request),
    });
    await quoted();
    expect(buyButton()).not.toHaveAttribute("aria-disabled");

    slow = true;
    act(() => layer.cache.invalidate(["quote", ASSET_ID]));

    await waitFor(() =>
      expect(buyButton()).toHaveAttribute("aria-disabled", "true"),
    );
    // The old numbers stay on screen, marked busy, until the new quote arrives.
    expect(screen.getByLabelText("Quote")).toHaveAttribute("aria-busy", "true");
    fireEvent.submit(units().closest("form")!);
    expect(backend.calls(ORDER)).toBe(0);

    await act(async () =>
      release(
        quoteFor(
          new Request(`${BASE}/assets/${ASSET_ID}/quote?side=buy&qty=10`),
          {
            total: "210.00",
          },
        ),
      ),
    );
    await quoted("$210.00");
    expect(buyButton()).not.toHaveAttribute("aria-disabled");
  });

  it("explains insufficient cash from the order and re-reads the balance", async () => {
    const { backend } = renderPanel({
      [ORDER]: () => json({ detail: "insufficient_cash" }, { status: 409 }),
    });
    await quoted();
    const portfolioReads = backend.calls("GET /portfolio");

    buyButton().focus();
    fireEvent.click(buyButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "You don't have enough play money for this order now. Nothing was traded.",
      ),
    );
    // A units problem: focus stays on the button, and the units field is described by it.
    expect(buyButton()).toHaveFocus();
    expect(units()).toHaveAccessibleDescription(
      /You don't have enough play money for this order now/,
    );
    await waitFor(() =>
      expect(backend.calls("GET /portfolio")).toBeGreaterThan(portfolioReads),
    );
    expect(screen.queryByText(/Stake added/)).not.toBeInTheDocument();
  });

  it("points only the active tab at a panel", async () => {
    renderPanel({
      "GET /portfolio": () =>
        json(portfolio({ holdings: [holding({ shares: 5 })] })),
    });
    const sellTab = await screen.findByRole("tab", { name: "Sell units" });
    await waitFor(() => expect(sellTab).toBeEnabled());
    const buyTab = screen.getByRole("tab", { name: "Buy units" });

    const panel = screen.getByRole("tabpanel");
    expect(buyTab).toHaveAttribute("aria-controls", panel.id);
    expect(sellTab).not.toHaveAttribute("aria-controls");
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
    expect(pending).toHaveAttribute("aria-disabled", "true");
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
    [409, "not_trading", /isn't trading yet/, null],
    [409, "insufficient_cash", /enough play money/, null],
    [409, "insufficient_shares", /more units than you hold/, null],
    [409, "insufficient_supply", /Not enough units are available/, null],
    [409, "price_moved", /price moved since your quote/, null],
    [409, "Asset is not listed for trading", /isn't open for trading/, null],
    [400, "order_too_large", /more units than one order can take/, null],
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

      buyButton().focus();
      fireEvent.click(buyButton());

      const alert = await screen.findByRole("alert");
      await waitFor(() => expect(alert).toHaveTextContent(message));
      // Focus stays on the button whatever the outcome; only a units problem describes the
      // units field (not a sign-in, a may-have-filled or a closed market).
      expect(buyButton()).toHaveFocus();
      const unitsProblem =
        status === 422 ||
        [
          "insufficient_cash",
          "insufficient_shares",
          "insufficient_supply",
          "order_too_large",
        ].includes(detail as string);
      if (unitsProblem) expect(units()).toHaveAccessibleDescription(message);
      else expect(units()).not.toHaveAccessibleDescription(message);
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

    buyButton().focus();
    fireEvent.click(buyButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /couldn't confirm your order.*may have gone through/,
      ),
    );
    expect(backend.calls(ORDER)).toBe(1);
    // Not a units problem: focus stays put and the units field isn't described by it.
    expect(buyButton()).toHaveFocus();
    expect(units()).not.toHaveAccessibleDescription(/couldn't confirm/);
  });

  it("shows a quote failure on the units field", async () => {
    renderPanel({
      [QUOTE]: () => json({ detail: "order_too_large" }, { status: 400 }),
    });

    // Even the 1-unit quote is refused here, so there's no number to offer: no fix either.
    await waitFor(() =>
      expect(units()).toHaveAccessibleDescription(
        "That's more units than one order can take.",
      ),
    );
    expect(
      screen.getByText("That's more units than one order can take."),
    ).toHaveAttribute("aria-live", "polite");
    expect(
      screen.queryByRole("button", { name: /^Change to/ }),
    ).not.toBeInTheDocument();
    expect(buyButton()).toHaveAttribute("aria-disabled", "true");
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

  describe("refusals and their fix (#216 WP2)", () => {
    const qtyOf = (r: Request) => new URL(r.url).searchParams.get("qty");
    const oneUnitQuotes = (backend: ReturnType<typeof fakeBackend>) =>
      backend.requests.filter(
        (r) => r.url.includes("/quote") && qtyOf(r) === "1",
      ).length;
    const tick = (id: number) =>
      act(() => {
        const source = FakeEventSource.latest();
        source.open();
        source.emit("price_tick", id, {
          asset_id: ASSET_ID,
          price: "20.5000",
          reason: "tick",
        });
      });

    it("washes the balance after a fill on a layer, without remounting its numbers", async () => {
      renderPanel();
      await quoted();
      const balance = await screen.findByTestId("trade-balance");
      expect(screen.queryByTestId("trade-balance-wash")).toBeNull();

      fireEvent.click(buyButton());
      await screen.findByText(/Stake added/);
      expect(screen.getByTestId("trade-balance")).toBe(balance);
      expect(screen.getByTestId("trade-balance-wash")).toHaveClass("ww-wash");
      expect(screen.getByTestId("trade-balance-wash")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    });

    it("never asks for a 1-unit quote when the order's own quote is fine", async () => {
      const { backend } = renderPanel();
      await quoted();
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
      tick(1);
      await waitFor(() =>
        expect(
          backend.requests.filter((r) => r.url.includes("/quote")).length,
        ).toBeGreaterThan(1),
      );
      expect(oneUnitQuotes(backend)).toBe(0);
    });

    it("stops refreshing the 1-unit quote on ticks once the size is fixed", async () => {
      const { backend } = renderPanel({
        [QUOTE]: (request) =>
          qtyOf(request) === "1" || Number(qtyOf(request)) <= 279
            ? quoteFor(request, { max_qty: 279 })
            : json({ detail: "order_too_large" }, { status: 400 }),
      });
      fireEvent.change(await screen.findByLabelText("Units"), {
        target: { value: "999999999" },
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Change to 279 units" }),
      );
      await quoted();
      const asked = oneUnitQuotes(backend);
      expect(asked).toBe(1);

      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
      const quotesBefore = backend.calls(QUOTE);
      tick(1);
      await waitFor(() =>
        expect(backend.calls(QUOTE)).toBeGreaterThan(quotesBefore),
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(oneUnitQuotes(backend)).toBe(asked);
    });

    it("moves focus to the units field when the focused fix goes away on a refresh", async () => {
      let cash = "150.00";
      let max = 7;
      renderPanel({
        "GET /portfolio": () => json(portfolio({ cash_balance: cash })),
        [QUOTE]: (request) => quoteFor(request, { max_qty: max }),
      });
      await quoted();
      const fix = await screen.findByRole("button", {
        name: "Change to 7 units",
      });
      fix.focus();
      expect(fix).toHaveFocus();

      // A deposit of play money elsewhere: the next read has enough, so the fix goes.
      cash = "1000.00";
      max = 49;
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
      tick(1);
      await waitFor(() => expect(fix).not.toBeInTheDocument());
      expect(units()).toHaveFocus();
    });

    it("announces a refused order once: the alert, not the field as well", async () => {
      let cash = "10000.00";
      renderPanel({
        "GET /portfolio": () => json(portfolio({ cash_balance: cash })),
        [ORDER]: () => {
          cash = "150.00";
          return json({ detail: "insufficient_cash" }, { status: 409 });
        },
      });
      await quoted();
      fireEvent.click(buyButton());

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "You don't have enough play money for this order now. Nothing was traded.",
      );
      const field = await screen.findByText(
        "You have $150.00 of play money. This needs $200.20.",
      );
      expect(field).toHaveAttribute("aria-live", "off");
      // Still on screen and describing the field.
      expect(units()).toHaveAccessibleDescription(
        /You have \$150\.00 of play money/,
      );
      // Typing again ends the refusal: the field speaks for itself again.
      fireEvent.change(units(), { target: { value: "5" } });
      expect(field).toHaveAttribute("aria-live", "polite");
    });
  });
});
