/**
 * The sandbox journey on the real stack (Postgres, FastAPI, Next.js; USE_MOCKS=true), as a
 * judge takes it (ADR-0008): the welcome, then "Try it yourself" opens a private sandbox with
 * no sign-up. Rosa's community lists a site (name, draw, rate, skip the documents, send the
 * offer), the Reviewer approves it, Arjun backs it and finds it in Your stakes. Along the way it
 * checks in the browser that a supporter is refused the community's and the Reviewer's actions.
 */
import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";

import { randomUUID } from "node:crypto";

import { WEB_ORIGIN } from "./env";
import { uniquePng } from "./png";
import { closeSessions, newSession } from "./session";

// Unique per run, so a site name never collides with an earlier run's.
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const SITE = `Cloud Forest ${RUN}`;
// Somewhere in Kenya, far from the curated sites.
const CENTER = "0.7000, 37.5000";

/** Rating runs are async (queued, then a worker); with mocks they take seconds. */
const RATING_TIMEOUT = 120_000;

test.afterEach(closeSessions);

/** Be someone else in this sandbox, from the header's person menu. */
async function become(page: Page, person: "Rosa" | "Arjun" | "Reviewer") {
  await page.getByRole("button", { name: /^Viewing as / }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(person) }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`^Viewing as ${person}`) }),
  ).toBeVisible();
}

/** The sandbox API through the frontend's same-origin proxy, with this sandbox's cookie. */
function sandboxPost(
  page: Page,
  path: string,
  data: Buffer | Record<string, unknown>,
  contentType = "application/json",
): Promise<APIResponse> {
  return page.request.fetch(`/api/sandbox${path}`, {
    method: "POST",
    data,
    // The backend's CSRF check wants an allowed Origin; without it a 403 would prove nothing.
    headers: { Origin: WEB_ORIGIN, "Content-Type": contentType },
  });
}

async function expectRefused(
  response: APIResponse,
  status: number,
  reason: string,
): Promise<void> {
  expect(response.status()).toBe(status);
  expect(await response.json()).toEqual({ detail: reason });
}

function tradePanel(page: Page): Locator {
  return page.getByRole("region", { name: "Back this site" });
}

test("the sandbox: list, review, back and follow a site", async ({
  browser,
}) => {
  const context = await newSession(browser, { reducedMotion: "reduce" });
  const page = await context.newPage();
  let assetId = "";
  let sentAt = "";
  let communityHref = "";

  await test.step("the welcome opens a sandbox, no sign-up", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Try it yourself" }).click();
    await expect(page).toHaveURL(/\/sandbox$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Marketplace" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Viewing as Arjun/ }),
    ).toBeVisible();
  });

  await test.step("Rosa names and draws land for her community", async () => {
    await become(page, "Rosa");
    await expect(
      page.getByRole("heading", { level: 1, name: "Communities" }),
    ).toBeVisible();
    // Whichever community comes first: the journey comes back to this one at the end.
    const first = page
      .getByRole("list", { name: "Your communities" })
      .getByRole("link")
      .first();
    communityHref = (await first.getAttribute("href")) ?? "";
    expect(communityHref).toMatch(/[?&]community=/);
    await first.click();
    await page.getByRole("link", { name: "List more land" }).click();

    await page.getByLabel("Site name").fill(SITE);
    await page
      .getByRole("checkbox", { name: /has the right to list this land/ })
      .check();
    await page.getByRole("button", { name: "Continue to boundary" }).click();

    // Find the land by its coordinates, then click four corners on the real Leaflet map. Reduced
    // motion makes "Go there" jump instead of flying, so no click lands mid-flight.
    const map = page.getByRole("application", { name: /^Boundary map/ });
    await expect(map.getByRole("button", { name: "Zoom in" })).toBeVisible();
    await page.getByRole("textbox", { name: "Coordinates" }).fill(CENTER);
    await page.getByRole("button", { name: "Go there" }).click();
    const box = await map.boundingBox();
    if (!box) throw new Error("the boundary map has no size");
    const [x, y, d] = [box.width / 2, box.height / 2, 110];
    for (const [dx, dy] of [
      [-d, -d],
      [d, -d],
      [d, d],
      [-d, d],
    ]) {
      await map.click({ position: { x: x + dx, y: y + dy } });
    }
    await expect(page.getByText("4 corners")).toBeVisible();
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(
      page.getByText("Shape, size and overlap look right."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.getByRole("button", { name: "Rate this site" }),
    ).toBeVisible();
    // The new listing's id joins the address once the draft is saved.
    await expect(page).toHaveURL(/[?&]asset=/);
    assetId = new URL(page.url()).searchParams.get("asset") ?? "";
    expect(assetId).not.toBe("");
  });

  await test.step("the rating lists it; documents are optional", async () => {
    await page.getByRole("button", { name: "Rate this site" }).click();
    await expect(
      page.getByRole("heading", { name: `${SITE} is listed` }),
    ).toBeVisible({ timeout: RATING_TIMEOUT });
    // USE_MOCKS: the UI must say the metrics are placeholders.
    await expect(page.getByText(/^Mock data: this rating used/)).toBeVisible();
    await page
      .getByRole("button", { name: /Continue: show it's yours/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "Show it's yours" }),
    ).toBeVisible();
    // ADR-0006 §5: who may read the documents, before any upload.
    await expect(page.getByRole("note")).toBeVisible();
    await page.getByRole("button", { name: /Skip for now/ }).click();
  });

  await test.step("Rosa sends her offer; it waits off the Marketplace", async () => {
    await expect(
      page.getByRole("heading", { name: "Set your offer" }),
    ).toBeVisible();
    const send = page.getByRole("button", { name: /Send for review/ });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(
      page.getByRole("heading", { name: "Waiting for the Reviewer" }),
    ).toBeVisible();
    // Coming back resumes at the same step.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Waiting for the Reviewer" }),
    ).toBeVisible();
    const detail = await page.request.get(`/api/sandbox/assets/${assetId}`);
    expect(detail.ok()).toBe(true);
    sentAt = (await detail.json()).offer.sent_at;
    expect(sentAt).toBeTruthy();
  });

  await test.step("the Reviewer approves it and it opens on the Marketplace", async () => {
    await page
      .getByRole("button", { name: /Review it as the Reviewer/ })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Reviews" }),
    ).toBeVisible();
    const offer = page
      .getByRole("list", { name: "Offers waiting for review" })
      .getByRole("listitem")
      .filter({ hasText: SITE });
    await offer.getByRole("button", { name: /Approve and list/ }).click();
    await expect(page.getByText(`${SITE} is on the Marketplace`)).toBeVisible();
    await expect(offer).toHaveCount(0);
  });

  await test.step("Arjun is refused the community's and the Reviewer's actions", async () => {
    await become(page, "Arjun");
    await expectRefused(
      await sandboxPost(page, `/assets/${assetId}/offer`, {
        total_shares: 1_000_000,
        retained_pct: "51",
        expected_price: "1",
      }),
      403,
      "owner_only",
    );
    await expectRefused(
      await sandboxPost(page, `/admin/assets/${assetId}/offer/send-back`, {
        sent_at: sentAt,
        note: "Taken over.",
      }),
      403,
      "admin_only",
    );
    await expectRefused(
      await sandboxPost(
        page,
        `/assets/${assetId}/documents?doc_type=title`,
        uniquePng(),
        "image/png",
      ),
      403,
      "members_only",
    );
    // The Reviewer's page tells a supporter it isn't theirs, rather than showing the queue.
    await page.goto("/sandbox/admin/verifications");
    await expect(
      page.getByRole("heading", { name: "Only the Reviewer sees this page" }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Offers waiting for review" }),
    ).toHaveCount(0);
  });

  await test.step("Arjun backs the site from its page", async () => {
    await page
      .getByRole("banner")
      .getByRole("link", { name: "Marketplace", exact: true })
      .click();
    await page
      .getByRole("link", { name: new RegExp(SITE) })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: SITE }),
    ).toBeVisible();
    const panel = tradePanel(page);
    await panel.getByRole("textbox", { name: "Units" }).fill("100");
    const buy = panel.getByRole("button", { name: "Buy 100 units" });
    // The order button stays focusable but inert (aria-disabled) until its quote is in.
    await expect(buy).not.toHaveAttribute("aria-disabled", "true");
    await buy.click();
    const status = panel.getByRole("status");
    await expect(status).toContainText("Bought 100 units");
    await expect(status).toContainText(/You paid \$[\d,]+\.\d{2}/);
  });

  await test.step("Your stakes shows it, and how it's doing", async () => {
    await page
      .getByRole("banner")
      .getByRole("link", { name: "Your stakes" })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Your stakes" }),
    ).toBeVisible();
    const money = page.getByRole("region", { name: "Your money" });
    await expect(money).toContainText("In stakes");
    await expect(money).toContainText("You paid");
    await expect(money).toContainText("Sandbox balance");
    const stake = page
      .getByRole("list", { name: "Stakes" })
      .getByRole("listitem")
      .filter({ hasText: SITE });
    await expect(stake).toContainText("100 units");
    await expect(stake).toContainText("Worth now");
    await expect(stake.getByRole("link", { name: SITE })).toHaveAttribute(
      "href",
      `/sandbox/asset/${assetId}`,
    );
  });

  await test.step("Rosa's community shows the site on the Marketplace", async () => {
    await become(page, "Rosa");
    await page.goto(communityHref);
    await expect(
      page.getByRole("link", {
        name: new RegExp(`^${SITE}\\s*: On the Marketplace\\. See it$`),
      }),
    ).toBeVisible();
  });
});
