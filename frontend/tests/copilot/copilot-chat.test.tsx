import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CopilotChat, answerChips } from "@/components/copilot-chat";
import { SLOW_AFTER_MS } from "@/components/loading-region";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { json, SIGNED_IN_WORLD } from "../lib/helpers";
import { answerEvents, ASSET_ID, EVENT_SOURCE, sseResponse } from "./fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/asset/${ASSET_ID}`,
  useSearchParams: () => new URLSearchParams("tab=overview"),
}));

beforeAll(stubBrowserApis);

const signedIn = { "GET /world": () => json(SIGNED_IN_WORLD) };

function chat() {
  return <CopilotChat assetId={ASSET_ID} assetName="Xochimilco wetland" />;
}

describe("CopilotChat, Bea's moments", () => {
  it("greets with the site's grade change, and reacts to it once", async () => {
    renderExchange(chat(), {
      ...signedIn,
      [`GET /assets/${ASSET_ID}/reports`]: () =>
        json([{ grade: "BB" }, { grade: "A" }]),
    });

    expect(
      await screen.findByText(
        /Xochimilco wetland was lowered A → BB\. Ask me why\./,
      ),
    ).toBeVisible();
    const bea = document.querySelector('[data-state="downgrade"]');
    expect(bea).toHaveClass("bea-react-down");
  });

  it("says she's waking up when the server is slow to answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderExchange(chat(), {
        ...signedIn,
        "POST /copilot": () => new Promise<Response>(() => {}),
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "What drives this grade?" }),
      );
      expect(
        await screen.findByText("Bea is reading the Record…"),
      ).toBeVisible();
      await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
      expect(await screen.findByText("Bea is waking up…")).toBeVisible();
      expect(document.querySelector('[data-state="waking"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CopilotChat", () => {
  it("asks signed-out visitors to sign in and come back", async () => {
    renderExchange(chat());

    expect(
      await screen.findByRole("link", { name: "Sign in to ask Bea" }),
    ).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(`/asset/${ASSET_ID}?tab=overview`)}`,
    );
  });

  it("renders the streamed answer with each citation linking to its source", async () => {
    // jsdom has no layout: give the answer list a height so following it is observable.
    const height = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === "copilot-turns" ? 900 : 0;
      });
    const { backend } = renderExchange(chat(), {
      ...signedIn,
      "POST /copilot": () => sseResponse(answerEvents()),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Why did the price change?" }),
    );

    const event = await screen.findByRole("link", {
      name: `Source E55555555: ${EVENT_SOURCE.title}`,
    });
    expect(event).toHaveAttribute("href", `/asset/${ASSET_ID}?tab=news`);
    expect(
      screen.getByRole("link", { name: "Source R2: Proof of Life v2" }),
    ).toHaveAttribute("href", `/asset/${ASSET_ID}?tab=report`);
    const sources = screen.getByRole("list", {
      name: "Sources of this answer",
    });
    expect(within(sources).getAllByRole("link")).toHaveLength(2);
    // What made the answer, in plain words.
    const made = screen.getByRole("list", { name: "How this answer was made" });
    expect(
      within(made)
        .getAllByRole("listitem")
        .map((c) => c.textContent),
    ).toEqual([
      expect.stringMatching(/^Searched the Record · \d+ sources?$/),
      "Written by Nemotron 3 Nano",
      "Code checked 2 citations",
    ]);
    expect(screen.getByText(/health fell from 77.60 to 72.30/)).toBeVisible();
    // Bea opens her first answer with "Bzz" (ux-writing §6).
    expect(screen.getByTestId("copilot-turns")).toHaveTextContent(
      /Bzz\. An encroachment event/,
    );
    // The list follows the answer down to its source links.
    expect(screen.getByTestId("copilot-turns").scrollTop).toBe(900);
    height.mockRestore();
    const [request] = backend.requests.filter((r) => r.method === "POST");
    expect(await request!.json()).toEqual({
      question: "Why did the price change?",
      asset_id: ASSET_ID,
    });
  });

  it("renders bold and italic around a citation link, never raw markers", async () => {
    const answer =
      "Health **fell to 72.30 [R2]** after an *encroachment* [E55555555].";
    renderExchange(chat(), {
      ...signedIn,
      "POST /copilot": () => sseResponse(answerEvents(answer)),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Why did the price change?" }),
    );

    const link = await screen.findByRole("link", {
      name: "Source R2: Proof of Life v2",
    });
    const strong = link.closest("strong");
    expect(strong).toHaveTextContent("fell to 72.30 R2");
    expect(screen.getByText("encroachment").tagName).toBe("EM");
    expect(screen.getByTestId("copilot-turns")).not.toHaveTextContent("*");
  });

  it("shows a refusal without sources", async () => {
    const refusal = "I couldn't find that in the Record.";
    renderExchange(chat(), {
      ...signedIn,
      "POST /copilot": () =>
        sseResponse([
          { type: "sources", sources: [] },
          { type: "delta", text: refusal },
          { type: "done", answer: refusal, citations: [], mode: "refusal" },
        ]),
    });

    const input = await screen.findByLabelText(
      "Ask Bea about Xochimilco wetland",
    );
    fireEvent.change(input, { target: { value: "Capital of France?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText("Sources:")).not.toBeInTheDocument();
    // Never "Bzz" on a refusal.
    await waitFor(() =>
      expect(screen.getByTestId("copilot-turns")).not.toHaveTextContent("Bzz"),
    );
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("explains errors before the stream", async () => {
    renderExchange(chat(), {
      ...signedIn,
      "POST /copilot": () =>
        json({ detail: "copilot_unavailable" }, { status: 503 }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "What drives this grade?" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bea can't search the Record right now.",
    );
  });

  it("keeps the partial answer and explains an error event mid-stream", async () => {
    renderExchange(chat(), {
      ...signedIn,
      "POST /copilot": () =>
        sseResponse([
          { type: "sources", sources: [EVENT_SOURCE] },
          { type: "delta", text: "An encroachment event " },
          { type: "error", detail: "copilot_failed" },
        ]),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Why did the price change?" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bea couldn't finish this answer.",
    );
    expect(screen.getByText("An encroachment event")).toBeInTheDocument();
    expect(screen.queryByText("Sources:")).not.toBeInTheDocument();
  });

  it("aborts the request in flight when it unmounts", async () => {
    let request: Request | undefined;
    const { unmount } = renderExchange(chat(), {
      ...signedIn,
      "POST /copilot": (r) => {
        request = r;
        return new Promise<Response>(() => {});
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Why did the price change?" }),
    );
    await waitFor(() => expect(request).toBeDefined());
    expect(request!.signal.aborted).toBe(false);
    unmount();

    expect(request!.signal.aborted).toBe(true);
  });
});

describe("answerChips", () => {
  it("says who wrote the answer, or that code quoted it, and what code checked", () => {
    const base = { sourcesFound: 1, model: null, citations: [] };
    expect(answerChips({ ...base, mode: "extractive" })).toEqual([
      "Searched the Record · 1 source",
      "Quoted by code, no model",
      "No citation to check",
    ]);
    expect(answerChips({ ...base, mode: "refusal" })).toEqual([
      "Searched the Record · 1 source",
      "Not in the Record",
    ]);
  });
});
