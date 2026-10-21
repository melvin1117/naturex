import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CopilotSheet } from "@/components/proto/copilot-sheet";
import { PrototypeHeaderTools } from "@/components/proto/header-tools";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { FakeEventSource, json, SIGNED_IN_WORLD } from "../lib/helpers";
import {
  answerEvents,
  ASSET_ID,
  EVENT_SOURCE,
  REPORT_SOURCE,
  sseResponse,
} from "./fixtures";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

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

function renderHeader(routes: Routes = {}) {
  return renderExchange(
    <>
      <PrototypeHeaderTools app="exchange" />
      <CopilotSheet />
    </>,
    routes,
  );
}

async function openCopilot(): Promise<{
  opener: HTMLElement;
  sheet: HTMLElement;
}> {
  const opener = await screen.findByRole("button", { name: "Copilot" });
  opener.focus();
  fireEvent.click(opener);
  const sheet = await screen.findByRole("dialog", { name: "Copilot" });
  return { opener, sheet };
}

async function requests(backend: ReturnType<typeof renderHeader>["backend"]) {
  return Promise.all(
    backend.requests
      .filter((r) => r.method === "POST")
      .map((r) => r.clone().json() as Promise<unknown>),
  );
}

describe("Header Copilot, signed in", () => {
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

    fireEvent.click(
      within(sheet).getByRole("button", {
        name: "Which sites were downgraded?",
      }),
    );

    const chip = await within(sheet).findByRole("link", {
      name: `Source ${REPORT_SOURCE.ref}: Xochimilco wetland · Report v2`,
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
      name: `Source ${REPORT_SOURCE.ref}: Report v2`,
    });

    fireEvent.click(within(scope).getByRole("radio", { name: "All sites" }));
    expect(
      within(scope).getByRole("radio", { name: "All sites" }),
    ).toHaveAttribute("aria-checked", "true");
    const input = within(sheet).getByLabelText(
      "Ask the Copilot about every site",
    );
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
      "The Copilot has answered a lot of questions in this sandbox this hour.",
    );
  });

  it("puts focus back on the Copilot button when closed", async () => {
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

describe("Header Copilot, anonymous", () => {
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
