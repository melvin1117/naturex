import { fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { VerificationPanel } from "@/components/verification/verification-panel";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { ADMIN_WORLD, json, sequence } from "../lib/helpers";
import { ASSET_ID, NOT_CHECKED, panel, verifiedPanel } from "./fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/asset/${ASSET_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(stubBrowserApis);

const PANEL = `GET /assets/${ASSET_ID}/verification`;

function show(
  body: ReturnType<typeof panel>,
  routes: Parameters<typeof renderExchange>[1] = {},
) {
  return renderExchange(<VerificationPanel assetId={ASSET_ID} />, {
    [PANEL]: () => json(body),
    ...routes,
  });
}

const region = () =>
  screen.getByRole("region", { name: "How this listing was verified" });

describe("VerificationPanel", () => {
  it("shows a verified listing: badge, level, date, reviewer role, checks, what wasn't checked and the ledger entry", async () => {
    show(verifiedPanel());

    expect(
      await screen.findByText(
        "Documents reviewed by WildWorth (hackathon process)",
      ),
    ).toBeInTheDocument();
    const panelEl = region();
    expect(within(panelEl).getByText("Verified land")).toBeInTheDocument();
    expect(within(panelEl).getByText("Decided on")).toBeInTheDocument();
    expect(within(panelEl).getByText("19 Oct 2026")).toBeInTheDocument();
    expect(
      within(panelEl).getByText("WildWorth platform admin"),
    ).toBeInTheDocument();

    const checks = within(panelEl).getByRole("list", {
      name: "Checks and their results",
    });
    expect(within(checks).getAllByRole("listitem")).toHaveLength(4);
    expect(within(checks).getAllByText("Passed")).toHaveLength(4);
    expect(
      within(checks).getByText("Consent-labelled document attached"),
    ).toBeInTheDocument();
    // The consent check is never over-read.
    expect(
      within(checks).getByText(/not that consent exists/),
    ).toBeInTheDocument();
    for (const item of NOT_CHECKED)
      expect(within(panelEl).getByText(item)).toBeInTheDocument();

    const ledger = within(panelEl).getByRole("link", {
      name: /the Record \(entry #7\)/,
    });
    expect(ledger).toHaveAttribute(
      "href",
      `/asset/${ASSET_ID}?tab=ledger#ledger-entry-7`,
    );
    // Public: no values, documents or reviewer names.
    expect(panelEl.textContent).not.toMatch(/no overlap|bound to this listing/);
    expect(
      within(panelEl).queryByRole("link", { name: /control room/ }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["unverified", "Self-attested by the community"],
    ["revoked", "Verification revoked"],
    [
      "verified",
      "Demo verification: sample documents, no real ownership checked",
    ],
  ] as const)(
    "shows the API's badge for a %s listing word for word",
    async (level, badge) => {
      show(panel({ level, badge, revoked_at: "2026-10-20T00:00:00Z" }));
      const shown = await screen.findByText(badge);
      expect(shown.closest("[data-level]")).toHaveAttribute(
        "data-level",
        level,
      );
    },
  );

  it("says what an unverified listing lacks", async () => {
    show(panel());
    expect(
      await screen.findByText("Self-attested by the community"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(screen.getByText("No reviewer yet")).toBeInTheDocument();
    expect(screen.getByText(/No checks have run/)).toBeInTheDocument();
    expect(
      screen.getByText("No verification decision is in the Record yet."),
    ).toBeInTheDocument();
    for (const item of NOT_CHECKED)
      expect(screen.getByText(item)).toBeInTheDocument();
  });

  it("dates a revocation", async () => {
    show(
      panel({
        level: "revoked",
        badge: "Verification revoked",
        revoked_at: "2026-10-20T08:00:00Z",
        ledger_seq: 9,
      }),
    );
    expect(await screen.findByText("Revoked on")).toBeInTheDocument();
    expect(screen.getByText("20 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText(/trading is paused/)).toBeInTheDocument();
  });

  it("shows loading, then an error with a retry", async () => {
    show(panel(), {
      [PANEL]: sequence(
        () => json({ detail: "boom" }, { status: 500 }),
        () => json(verifiedPanel()),
      ),
    });
    expect(
      screen.getByText("Loading the verification record…"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("We couldn't load how this listing was verified"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(
        "Documents reviewed by WildWorth (hackathon process)",
      ),
    ).toBeInTheDocument();
  });

  it("offers an admin the review screen", async () => {
    show(verifiedPanel(), { "GET /world": () => json(ADMIN_WORLD) });
    expect(
      await screen.findByRole("link", { name: /Review in the control room/ }),
    ).toHaveAttribute("href", `/admin/verifications/${ASSET_ID}`);
  });
});
