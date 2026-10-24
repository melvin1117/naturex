import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CopilotSheet } from "@/components/proto/copilot-sheet";
import { PrototypeHeaderTools } from "@/components/proto/header-tools";
import { TOUR_STEPS, useTour } from "@/components/proto/tour";
import type { CopilotStreamEvent } from "@/lib/api/types";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { FakeEventSource, json, SIGNED_IN_WORLD } from "../lib/helpers";
import {
  answerEvents,
  ASSET_ID,
  EVENT_SOURCE,
  REPORT_SOURCE,
  sseResponse,
} from "./fixtures";

// The pathname is a tiny store, so a test can navigate (browser Back) while the sheet is open.
const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    pathname: "/",
    listeners,
    go(pathname: string) {
      this.pathname = pathname;
      listeners.forEach((listener) => listener());
    },
  };
});
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
    usePathname: () =>
      useSyncExternalStore(
        (listener) => {
          nav.listeners.add(listener);
          return () => nav.listeners.delete(listener);
        },
        () => nav.pathname,
      ),
    useSearchParams: () => new URLSearchParams(),
  };
});

beforeAll(stubBrowserApis);
beforeEach(() => {
  FakeEventSource.reset();
  localStorage.clear();
  nav.pathname = "/";
});

const OSA_ID = "33333333-3333-4333-8333-333333333302";

const signedIn = {
  "GET /world": () => json(SIGNED_IN_WORLD),
  "GET /assets": () =>
    json([
      { id: ASSET_ID, name: "Xochimilco wetland", grade: "A" },
      { id: OSA_ID, name: "Osa forest", grade: "AA" },
      {
        id: "33333333-3333-4333-8333-333333333303",
        name: "Unrated draft",
        grade: null,
      },
    ]),
  [`GET /assets/${ASSET_ID}`]: () =>
    json({ id: ASSET_ID, name: "Xochimilco wetland" }),
  [`GET /assets/${OSA_ID}`]: () => json({ id: OSA_ID, name: "Osa forest" }),
  "POST /copilot": () => sseResponse(answerEvents()),
};

type Routes = Parameters<typeof renderExchange>[1];

function renderHeader(routes: Routes = {}, extra: ReactNode = null) {
  return renderExchange(
    <>
      {extra}
      <PrototypeHeaderTools app="exchange" />
      <CopilotSheet />
    </>,
    routes,
  );
}

/** An answer that has found its sources and then waits, until the request is cancelled. */
function hangingAnswer(signals: AbortSignal[]) {
  return (request: Request) => {
    signals.push(request.signal);
    const first: CopilotStreamEvent = { type: "sources", sources: [] };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(first)}\n\n`),
        );
        request.signal.addEventListener("abort", () =>
          controller.error(request.signal.reason),
        );
      },
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

function TourAtCopilot() {
  const tour = useTour();
  const step = TOUR_STEPS.findIndex((s) => s.target === "copilot-button");
  return (
    <button type="button" onClick={() => tour.go(step)}>
      Tour step: Copilot
    </button>
  );
}

async function openCopilot(): Promise<{
  opener: HTMLElement;
  sheet: HTMLElement;
}> {
  const opener = await screen.findByRole("button", { name: "Ask Bea" });
  opener.focus();
  fireEvent.click(opener);
  const sheet = await screen.findByRole("dialog", {
    name: "Bea · your field guide",
  });
  return { opener, sheet };
}

async function requests(backend: ReturnType<typeof renderHeader>["backend"]) {
  return Promise.all(
    backend.requests
      .filter((r) => r.method === "POST")
      .map((r) => r.clone().json() as Promise<unknown>),
  );
}

describe("Header Bea, signed in", () => {
  it("asks across every site by default, with sources named after their site", async () => {
    const { backend } = renderHeader(signedIn);
    await screen.findByRole("button", { name: /Alerts/ });
    const { sheet } = await openCopilot();

    // No mandatory site picker: the world-wide chat is ready.
    expect(
      within(sheet).queryByRole("combobox", { name: "Site to ask about" }),
    ).not.toBeInTheDocument();
    expect(
      within(sheet).queryByRole("radiogroup", { name: "Ask about" }),
    ).not.toBeInTheDocument();
    expect(within(sheet).getByText(/Ask across every site/)).toBeVisible();
    expect(within(sheet).queryByText(/scripted/)).not.toBeInTheDocument();
    // Her title, what she answers from, and that it's never advice.
    expect(sheet).toHaveAccessibleDescription(
      "Answers only from the Record of your sites Play money only; not advice.",
    );

    fireEvent.click(
      within(sheet).getByRole("button", {
        name: "Which sites were downgraded?",
      }),
    );

    const chip = await within(sheet).findByRole("link", {
      name: `Source ${REPORT_SOURCE.ref}: Xochimilco wetland · Proof of Life v2`,
    });
    expect(chip).toHaveAttribute("href", `/asset/${ASSET_ID}?tab=report`);
    expect(
      within(sheet).getByRole("link", {
        name: `Source ${EVENT_SOURCE.ref}: Xochimilco wetland · ${EVENT_SOURCE.title}`,
      }),
    ).toHaveAttribute("href", `/asset/${ASSET_ID}?tab=news`);
    expect(await requests(backend)).toEqual([
      { question: "Which sites were downgraded?" },
    ]);

    // Following a source closes the sheet.
    fireEvent.click(chip);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("starts on the open site's page, one tap from all sites, and keeps earlier answers", async () => {
    nav.pathname = `/asset/${ASSET_ID}`;
    const { backend } = renderHeader(signedIn);
    await screen.findByRole("button", { name: /Alerts/ });
    const { sheet } = await openCopilot();

    const scope = within(sheet).getByRole("radiogroup", { name: "Ask about" });
    const site = await within(scope).findByRole("radio", {
      name: "Xochimilco wetland",
    });
    expect(site).toHaveAttribute("aria-checked", "true");
    expect(
      within(sheet).getByText(/Ask about Xochimilco wetland/),
    ).toBeVisible();

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Why did the price change?" }),
    );
    await within(sheet).findByRole("link", {
      name: `Source ${REPORT_SOURCE.ref}: Proof of Life v2`,
    });

    const all = within(scope).getByRole("radio", { name: "All sites" });
    await waitFor(() => expect(all).toBeEnabled());
    fireEvent.click(all);
    expect(
      within(scope).getByRole("radio", { name: "All sites" }),
    ).toHaveAttribute("aria-checked", "true");
    const input = within(sheet).getByLabelText("Ask Bea about every site");
    fireEvent.change(input, { target: { value: "Which site fell most?" } });
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Send question" }),
    );

    await waitFor(() => expect(backend.calls("POST /copilot")).toBe(2));
    // The first answer is still there.
    expect(within(sheet).getByText("Why did the price change?")).toBeVisible();
    expect(await requests(backend)).toEqual([
      { question: "Why did the price change?", asset_id: ASSET_ID },
      { question: "Which site fell most?" },
    ]);
  });

  it("can narrow to one rated site, as an option", async () => {
    const { backend } = renderHeader(signedIn);
    await screen.findByRole("button", { name: /Alerts/ });
    const { sheet } = await openCopilot();

    const narrow = await within(sheet).findByRole("button", {
      name: "Narrow to one site",
    });
    fireEvent.keyDown(narrow, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByRole("menuitemradio", { name: "Unrated draft" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Osa forest" }),
    );

    expect(
      await within(sheet).findByRole("radio", { name: "Osa forest" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(
      within(sheet).getByRole("button", { name: "What drives this grade?" }),
    );
    await waitFor(() => expect(backend.calls("POST /copilot")).toBe(1));
    expect(await requests(backend)).toEqual([
      { question: "What drives this grade?", asset_id: OSA_ID },
    ]);
  });

  it("explains the rate limit", async () => {
    renderHeader({
      ...signedIn,
      "POST /copilot": () =>
        json({ detail: "copilot_rate_limited" }, { status: 429 }),
    });
    await screen.findByRole("button", { name: /Alerts/ });
    const { sheet } = await openCopilot();

    fireEvent.click(
      within(sheet).getByRole("button", {
        name: "Which sites were downgraded?",
      }),
    );

    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "Bea has answered a lot of questions in this sandbox this hour.",
    );
  });

  it("puts focus back on the Ask Bea button when closed", async () => {
    renderHeader(signedIn);
    await screen.findByRole("button", { name: /Alerts/ });
    const { opener, sheet } = await openCopilot();
    await waitFor(() =>
      expect(sheet).toContainElement(document.activeElement as HTMLElement),
    );

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opener).toHaveFocus();
  });
});

describe("Header Bea, while an answer streams", () => {
  it("locks the scope until the answer ends", async () => {
    nav.pathname = `/asset/${ASSET_ID}`;
    const signals: AbortSignal[] = [];
    renderHeader({ ...signedIn, "POST /copilot": hangingAnswer(signals) });
    await screen.findByRole("button", { name: /Alerts/ });
    const { sheet } = await openCopilot();
    const scope = within(sheet).getByRole("radiogroup", { name: "Ask about" });
    const other = await within(sheet).findByRole("button", {
      name: "Ask about another site",
    });

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Why did the price change?" }),
    );

    await within(sheet).findByText(/Bea is reading 0 sources/);
    for (const radio of within(scope).getAllByRole("radio"))
      expect(radio).toBeDisabled();
    expect(other).toBeDisabled();
  });

  it("cancels the answer when the sheet closes", async () => {
    const signals: AbortSignal[] = [];
    renderHeader({ ...signedIn, "POST /copilot": hangingAnswer(signals) });
    await screen.findByRole("button", { name: /Alerts/ });
    const { sheet } = await openCopilot();
    fireEvent.click(
      within(sheet).getByRole("button", {
        name: "Which sites were downgraded?",
      }),
    );
    await within(sheet).findByText(/Bea is reading 0 sources/);
    expect(signals[0]?.aborted).toBe(false);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("Header Bea, when the page changes under it", () => {
  it("follows the page's site (browser Back) and keeps earlier answers", async () => {
    nav.pathname = `/asset/${ASSET_ID}`;
    const { backend } = renderHeader(signedIn);
    await screen.findByRole("button", { name: /Alerts/ });
    const { sheet } = await openCopilot();
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Why did the price change?" }),
    );
    await within(sheet).findByRole("link", {
      name: "Source R2: Proof of Life v2",
    });

    act(() => nav.go(`/asset/${OSA_ID}`));

    expect(
      await within(sheet).findByRole("radio", { name: "Osa forest" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(within(sheet).getByTestId("copilot-turns")).getByText(
        "Why did the price change?",
      ),
    ).toBeVisible();

    act(() => nav.go("/"));

    await waitFor(() =>
      expect(
        within(sheet).queryByRole("radiogroup", { name: "Ask about" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.change(within(sheet).getByLabelText("Ask Bea about every site"), {
      target: { value: "Which site fell most?" },
    });
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Send question" }),
    );
    await waitFor(() => expect(backend.calls("POST /copilot")).toBe(2));
    expect((await requests(backend))[1]).toEqual({
      question: "Which site fell most?",
    });
  });
});

describe("Header Bea, signed in during the guided tour", () => {
  it("keeps the tour's scripted sheet and never calls the Copilot API", async () => {
    const { backend } = renderHeader(signedIn, <TourAtCopilot />);
    await screen.findByRole("button", { name: /Alerts/ });

    fireEvent.click(screen.getByRole("button", { name: "Tour step: Copilot" }));
    const { sheet } = await openCopilot();

    expect(within(sheet).getByText(/scripted answers/)).toBeVisible();
    expect(
      within(sheet).queryByRole("radiogroup", { name: "Ask about" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Why did the price change?" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.calls("POST /copilot")).toBe(0);
  });
});

describe("Header Bea, anonymous", () => {
  it("keeps the scripted demo and never calls the Copilot API", async () => {
    const { backend } = renderHeader();
    const { sheet } = await openCopilot();

    expect(within(sheet).getByText(/scripted answers/)).toBeVisible();
    expect(
      within(sheet).getByRole("combobox", { name: "Site to ask about" }),
    ).toBeInTheDocument();
    expect(
      within(sheet).queryByRole("radiogroup", { name: "Ask about" }),
    ).not.toBeInTheDocument();
    expect(backend.calls("POST /copilot")).toBe(0);
  });
});
