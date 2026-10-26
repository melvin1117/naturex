import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TraceDrawer } from "@/components/trace/trace-drawer";
import type { AssetDetail, WorldOut } from "@/lib/api/types";

import asset from "../exchange/fixtures/asset.json";
import { renderExchange, stubBrowserApis } from "../exchange/render";
import { json, sequence, WORLD } from "../lib/helpers";
import celestun from "./fixtures/run-celestun.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/asset/1",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(stubBrowserApis);

const SITE = asset as unknown as AssetDetail;
const TRACE = `GET /runs/${celestun.run_id}/trace`;

const SANDBOX_WORLD: WorldOut = {
  ...WORLD,
  label: "visitor",
  me: {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Arjun",
    email: null,
    kind: "persona",
    is_admin: false,
    world_id: WORLD.id,
    persona: "arjun",
  },
};

/** Opened from app state, like the listing flow's "See every step" and the site page's URL. */
function Opener({ runId }: { runId: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        See every step
      </button>
      <TraceDrawer
        open={open}
        onOpenChange={setOpen}
        asset={SITE}
        runId={runId}
        recorded={null}
      />
    </>
  );
}

function renderDrawer(
  routes: Parameters<typeof renderExchange>[1],
  world: WorldOut = SANDBOX_WORLD,
) {
  const utils = renderExchange(<Opener runId={celestun.run_id} />, {
    "GET /world": () => json(world),
    ...routes,
  });
  const opener = screen.getByRole("button", { name: "See every step" });
  opener.focus();
  fireEvent.click(opener);
  return { ...utils, opener };
}

async function openSection(name: string) {
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name }));
}

describe("the Agent Trace drawer", () => {
  it("shows the run, which model does what and how the agents are tested", async () => {
    renderDrawer({ [TRACE]: () => json(celestun) });

    const dialog = await screen.findByRole("dialog", {
      name: `How ${SITE.name} was rated`,
    });
    expect(
      await within(dialog).findByText("Judged by Nemotron 3 Ultra"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("heading", {
        level: 3,
        name: "Which model does what",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("heading", {
        level: 3,
        name: "How the agents are tested",
      }),
    ).toBeInTheDocument();
  });

  it("puts focus back on what opened it when Esc closes it", async () => {
    const { opener } = renderDrawer({ [TRACE]: () => json(celestun) });
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog).toContainElement(document.activeElement as HTMLElement),
    );

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("shows no model prices in a sandbox", async () => {
    renderDrawer({ [TRACE]: () => json(celestun) });
    await openSection("Which model does what");
    expect(
      await screen.findByText("Orchestrator and News Scout"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/per 1M tokens/)).not.toBeInTheDocument();
  });

  it("shows them outside a sandbox", async () => {
    renderDrawer({ [TRACE]: () => json(celestun) }, WORLD);
    await openSection("Which model does what");
    expect(
      (await screen.findAllByText(/per 1M tokens/)).length,
    ).toBeGreaterThan(0);
  });

  it("says it's loading until the trace arrives", async () => {
    renderDrawer({ [TRACE]: () => new Promise<Response>(() => {}) });
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Loading the trace…",
    );
  });

  it("explains a failed load and tries again", async () => {
    renderDrawer({
      [TRACE]: sequence(
        () => json({ detail: "boom" }, { status: 503 }),
        () => json(celestun),
      ),
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't load the trace");

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByText("Judged by Nemotron 3 Ultra"),
    ).toBeInTheDocument();
  });

  it("offers no retry for a run whose trace is gone", async () => {
    renderDrawer({
      [TRACE]: () => json({ detail: "not_found" }, { status: 404 }),
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This rating run's trace isn't available");
    expect(
      within(alert).queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });
});
