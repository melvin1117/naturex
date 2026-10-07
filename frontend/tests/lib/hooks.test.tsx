import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";
import {
  useAsset,
  useAssets,
  useEvents,
  useLiveEvent,
  usePlaceOrder,
  usePortfolio,
  useReport,
  useWorld,
} from "@/lib/hooks";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
  WORLD,
} from "./helpers";

const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const ASSET = { id: ASSET_ID, name: "Wetland", price: "10.00" };
const portfolio = (cash: string) => ({
  cash_balance: cash,
  holdings: [],
  impact: {},
});

function renderWithWorld(
  ui: React.ReactNode,
  routes: Parameters<typeof fakeBackend>[0] = {},
) {
  const backend = fakeBackend({ "GET /world": () => json(WORLD), ...routes });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  const utils = render(<WorldProvider dataLayer={layer}>{ui}</WorldProvider>);
  return { ...utils, backend, layer };
}

function Portfolio() {
  const { data, error, isLoading } = usePortfolio();
  if (isLoading) return <p>Loading portfolio</p>;
  if (error) return <p role="alert">{error.message}</p>;
  return <p>Cash {data?.cash_balance}</p>;
}

function Assets() {
  const { data } = useAssets();
  return <p>{data?.length ?? 0} assets</p>;
}

function Asset({ id }: { id: string }) {
  const { data, error, status } = useAsset(id);
  return (
    <div>
      <p>Status {status}</p>
      {data && <p>Price {data.price}</p>}
      {error && <p role="alert">{error.message}</p>}
    </div>
  );
}

beforeEach(() => FakeEventSource.reset());

describe("WorldProvider", () => {
  it("shows a loading state, then renders screens once the world exists", async () => {
    const { backend } = renderWithWorld(
      <>
        <Portfolio />
        <Assets />
      </>,
      {
        "GET /portfolio": () => json(portfolio("100.00")),
        "GET /assets": () => json([ASSET]),
      },
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Opening your demo world",
    );
    expect(await screen.findByText("Cash 100.00")).toBeInTheDocument();
    expect(await screen.findByText("1 assets")).toBeInTheDocument();
    expect(backend.calls("GET /world")).toBe(1);
    expect(new URL(backend.requests[0]!.url).pathname).toBe("/api/world");
  });

  it("shows an accessible error with a retry when the world can't be opened", async () => {
    renderWithWorld(<p>Marketplace</p>, {
      "GET /world": sequence(
        () =>
          json(
            { detail: "The demo is busy; try again in a few minutes" },
            { status: 503, headers: { "Retry-After": "300" } },
          ),
        () => json(WORLD),
      ),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The demo is busy; try again in a few minutes",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Marketplace")).toBeInTheDocument();
  });
});

describe("query hooks", () => {
  it("go from loading to data", async () => {
    renderWithWorld(<Asset id={ASSET_ID} />, {
      [`GET /assets/${ASSET_ID}`]: () => json(ASSET),
    });
    expect(await screen.findByText("Status loading")).toBeInTheDocument();
    expect(await screen.findByText("Price 10.00")).toBeInTheDocument();
    expect(screen.getByText("Status success")).toBeInTheDocument();
  });

  it("go from loading to a friendly error", async () => {
    renderWithWorld(<Asset id={ASSET_ID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Not Found");
    expect(screen.getByText("Status error")).toBeInTheDocument();
  });

  it("don't fetch without an id", async () => {
    function Report() {
      const { status } = useReport(undefined);
      return <p>Report {status}</p>;
    }
    const { backend } = renderWithWorld(<Report />);
    expect(await screen.findByText("Report idle")).toBeInTheDocument();
    expect(backend.requests).toHaveLength(1);
  });

  it("abort the request when the screen unmounts", async () => {
    let seen: Request | undefined;
    const { unmount } = renderWithWorld(<Portfolio />, {
      "GET /portfolio": (request) => {
        seen = request;
        return new Promise<Response>(() => {});
      },
    });
    await waitFor(() => expect(seen).toBeDefined());

    unmount();

    expect(seen!.signal.aborted).toBe(true);
  });
});

describe("live updates", () => {
  it("connect while a live hook is mounted and patch prices on price_tick", async () => {
    const { backend } = renderWithWorld(
      <>
        <Asset id={ASSET_ID} />
        <Portfolio />
      </>,
      {
        [`GET /assets/${ASSET_ID}`]: () => json(ASSET),
        "GET /portfolio": sequence(
          () => json(portfolio("100.00")),
          () => json(portfolio("90.00")),
        ),
      },
    );
    expect(await screen.findByText("Price 10.00")).toBeInTheDocument();
    expect(await screen.findByText("Cash 100.00")).toBeInTheDocument();
    const source = FakeEventSource.latest();
    expect(source.url).toBe(`${BASE}/events/stream`);

    act(() => {
      source.open();
      source.emit("price_tick", 9, {
        asset_id: ASSET_ID,
        price: "10.40",
        reason: "trade",
      });
    });

    expect(await screen.findByText("Price 10.40")).toBeInTheDocument();
    expect(await screen.findByText("Cash 90.00")).toBeInTheDocument();
    expect(backend.calls("GET /portfolio")).toBe(2);
  });

  it("useLiveEvent and useEvents hide the transport", async () => {
    function Feed() {
      const [titles, setTitles] = useState<string[]>([]);
      const { transport } = useEvents();
      useLiveEvent("alert", (event) =>
        setTitles((t) => [...t, String(event.payload.title)]),
      );
      return (
        <p>
          {transport}: {titles.join(",")}
        </p>
      );
    }
    renderWithWorld(<Feed />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.latest().open();
      FakeEventSource.latest().emit("alert", 1, { title: "Fire" });
    });

    expect(await screen.findByText("sse: Fire")).toBeInTheDocument();
  });
});

describe("mutations", () => {
  it("usePlaceOrder refreshes the portfolio and the asset", async () => {
    function Trade() {
      const order = usePlaceOrder();
      return (
        <>
          <Portfolio />
          <Asset id={ASSET_ID} />
          <button
            onClick={() =>
              void order.mutate({ asset_id: ASSET_ID, side: "buy", qty: 1 })
            }
          >
            Buy
          </button>
          {order.error && <p role="alert">{order.error.message}</p>}
          {order.data && <p>Filled at {order.data.fill_price}</p>}
        </>
      );
    }
    const { backend } = renderWithWorld(<Trade />, {
      "GET /portfolio": sequence(
        () => json(portfolio("100.00")),
        () => json(portfolio("89.60")),
      ),
      [`GET /assets/${ASSET_ID}`]: sequence(
        () => json(ASSET),
        () => json({ ...ASSET, price: "10.40" }),
      ),
      "POST /orders": () =>
        json({
          id: "o1",
          asset_id: ASSET_ID,
          side: "buy",
          qty: 1,
          fill_price: "10.40",
          is_primary: true,
          created_at: "2026-10-07T00:00:00Z",
        }),
    });
    expect(await screen.findByText("Cash 100.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Buy" }));

    expect(await screen.findByText("Filled at 10.40")).toBeInTheDocument();
    expect(await screen.findByText("Cash 89.60")).toBeInTheDocument();
    expect(await screen.findByText("Price 10.40")).toBeInTheDocument();
    expect(backend.calls("POST /orders")).toBe(1);
  });

  it("usePlaceOrder surfaces a 409 as a friendly error without throwing", async () => {
    function Trade() {
      const order = usePlaceOrder();
      return (
        <>
          <button
            onClick={() =>
              void order.mutate({ asset_id: ASSET_ID, side: "buy", qty: 1 })
            }
          >
            Buy
          </button>
          {order.error && <p role="alert">{order.error.message}</p>}
        </>
      );
    }
    renderWithWorld(<Trade />, {
      "POST /orders": () =>
        json({ detail: "Asset has no price yet" }, { status: 409 }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Buy" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Asset has no price yet",
    );
  });

  it("useWorld().resetWorld swaps in the reset world", async () => {
    function World() {
      const { world, personas, resetWorld, isResetting } = useWorld();
      return (
        <>
          <p>
            {world?.label} with {personas.length} personas
          </p>
          <button disabled={isResetting} onClick={() => void resetWorld()}>
            Reset my demo
          </button>
        </>
      );
    }
    const { backend } = renderWithWorld(<World />, {
      "POST /world/reset": () => json({ ...WORLD, label: "demo-1 (reset)" }),
    });
    expect(
      await screen.findByText("demo-1 with 1 personas"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset my demo" }));

    expect(
      await screen.findByText("demo-1 (reset) with 1 personas"),
    ).toBeInTheDocument();
    expect(backend.calls("GET /world")).toBe(1);
  });
});
