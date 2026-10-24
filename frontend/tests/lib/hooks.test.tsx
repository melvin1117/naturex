import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { WorldGate, WorldProvider } from "@/components/world-provider";
import { createDataLayer, viewerKey } from "@/lib/data-layer";
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
  SIGNED_IN_WORLD,
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
  it("renders pages straight away and bootstraps the world once, first", async () => {
    const { backend } = renderWithWorld(
      <>
        <h1>Rated sites</h1>
        <Portfolio />
        <Assets />
      </>,
      {
        "GET /portfolio": () => json(portfolio("100.00")),
        "GET /assets": () => json([ASSET]),
      },
    );

    expect(
      screen.getByRole("heading", { name: "Rated sites" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(await screen.findByText("Cash 100.00")).toBeInTheDocument();
    expect(await screen.findByText("1 assets")).toBeInTheDocument();
    expect(backend.calls("GET /world")).toBe(1);
    expect(new URL(backend.requests[0]!.url).pathname).toBe("/api/world");
  });

  it("keeps ungated content visible when the world can't be opened", async () => {
    const { backend, layer } = renderWithWorld(<h1>Page not found</h1>, {
      "GET /world": () => json({ detail: "boom" }, { status: 500 }),
    });

    await waitFor(() =>
      expect(layer.session.getSnapshot().status).toBe("error"),
    );
    expect(backend.calls("GET /world")).toBe(1);
    expect(
      screen.getByRole("heading", { name: "Page not found" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("WorldGate", () => {
  it("shows a loading state, then the gated section once the world exists", async () => {
    renderWithWorld(
      <>
        <h1>Rated sites</h1>
        <WorldGate>
          <p>Gated</p>
        </WorldGate>
      </>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Opening your demo world",
    );
    expect(screen.getByRole("heading", { name: "Rated sites" })).toBeVisible();
    expect(await screen.findByText("Gated")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows an accessible error with a retry when the world can't be opened", async () => {
    const { backend } = renderWithWorld(
      <>
        <h1>Rated sites</h1>
        <WorldGate>
          <p>Gated</p>
        </WorldGate>
      </>,
      {
        "GET /world": sequence(
          () =>
            json(
              { detail: "The demo is busy; try again in a few minutes" },
              { status: 503, headers: { "Retry-After": "300" } },
            ),
          () => json(WORLD),
        ),
      },
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The demo is busy; try again in a few minutes",
    );
    expect(screen.getByRole("heading", { name: "Rated sites" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Gated")).toBeInTheDocument();
    expect(backend.calls("GET /world")).toBe(2);
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

describe("cache per viewer", () => {
  it("keys the viewer by world and account", () => {
    expect(viewerKey(null)).toBeNull();
    expect(viewerKey(WORLD)).toBe(`${WORLD.id}:anonymous`);
    expect(viewerKey(SIGNED_IN_WORLD)).toBe(
      `${WORLD.id}:${SIGNED_IN_WORLD.me!.id}`,
    );
  });

  it("refetches when the account changes in the same world, never showing the old one's data", async () => {
    const { backend, layer } = renderWithWorld(<Portfolio />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /portfolio": sequence(
        () => json(portfolio("100.00")),
        () => json(portfolio("250.00")),
        () => json(portfolio("999.00")),
      ),
    });
    expect(await screen.findByText("Cash 100.00")).toBeTruthy();

    act(() => layer.session.set({ ...SIGNED_IN_WORLD }));
    act(() =>
      layer.session.set({
        ...SIGNED_IN_WORLD,
        me: {
          ...SIGNED_IN_WORLD.me!,
          id: "55555555-5555-4555-8555-555555555555",
        },
      }),
    );

    // The previous account's cash is never shown while the new one loads.
    expect(screen.queryByText("Cash 100.00")).toBeNull();
    expect(await screen.findByText("Cash 250.00")).toBeTruthy();
    expect(backend.calls("GET /portfolio")).toBe(2);

    act(() => layer.session.set(WORLD));
    expect(await screen.findByText("Cash 999.00")).toBeTruthy();
    expect(backend.calls("GET /portfolio")).toBe(3);
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
        [`GET /assets/${ASSET_ID}`]: sequence(
          () => json(ASSET),
          () => json({ ...ASSET, price: "10.40" }),
        ),
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
    await waitFor(() =>
      expect(backend.calls(`GET /assets/${ASSET_ID}`)).toBe(2),
    );
  });

  it("refetch the asset after a tick, so a stale in-flight fetch can't win", async () => {
    let releaseStale: (() => void) | undefined;
    function RefetchableAsset() {
      const { data, refetch } = useAsset(ASSET_ID);
      return (
        <>
          {data && <p>Price {data.price}</p>}
          <button onClick={() => void refetch()}>Refresh</button>
        </>
      );
    }
    const { backend } = renderWithWorld(<RefetchableAsset />, {
      [`GET /assets/${ASSET_ID}`]: sequence(
        () => json(ASSET),
        () =>
          new Promise<Response>((resolve) => {
            releaseStale = () => resolve(json(ASSET)); // read before the trade
          }),
        () => json({ ...ASSET, price: "10.40" }),
      ),
    });
    expect(await screen.findByText("Price 10.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(releaseStale).toBeDefined());

    act(() => {
      FakeEventSource.latest().emit("price_tick", 9, {
        asset_id: ASSET_ID,
        price: "10.40",
        reason: "trade",
      });
    });
    expect(await screen.findByText("Price 10.40")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      releaseStale!();
    });

    await waitFor(() =>
      expect(backend.calls(`GET /assets/${ASSET_ID}`)).toBe(3),
    );
    expect(await screen.findByText("Price 10.40")).toBeInTheDocument();
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
      FakeEventSource.latest().emit("alert", 1, {
        alert_id: "a1",
        asset_id: "s1",
        title: "Fire",
      });
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
