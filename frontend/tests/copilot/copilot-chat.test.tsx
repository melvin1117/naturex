import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CopilotChat } from "@/components/copilot-chat";

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

describe("CopilotChat", () => {
  it("asks signed-out visitors to sign in and come back", async () => {
    renderExchange(chat());

    expect(
      await screen.findByRole("link", { name: "Sign in to ask the Copilot" }),
    ).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(`/asset/${ASSET_ID}?tab=overview`)}`,
    );
  });

  it("renders the streamed answer with each citation linking to its source", async () => {
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
      screen.getByRole("link", { name: "Source R2: Report v2" }),
    ).toHaveAttribute("href", `/asset/${ASSET_ID}?tab=report`);
    const sources = screen.getByRole("list");
    expect(within(sources).getAllByRole("link")).toHaveLength(2);
    expect(screen.getByText(/health fell from 77.60 to 72.30/)).toBeVisible();
    const [request] = backend.requests.filter((r) => r.method === "POST");
    expect(await request!.json()).toEqual({
      question: "Why did the price change?",
      asset_id: ASSET_ID,
    });
  });

  it("shows a refusal without sources", async () => {
    const refusal = "That isn't in the record I can see.";
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
      "Ask the Copilot about Xochimilco wetland",
    );
    fireEvent.change(input, { target: { value: "Capital of France?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText("Sources:")).not.toBeInTheDocument();
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
      "The Copilot can't search the record right now.",
    );
  });
});
