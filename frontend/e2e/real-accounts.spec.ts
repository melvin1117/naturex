/**
 * T74 · Real-account E2E on the real stack (Postgres, FastAPI, Next.js; USE_MOCKS=true).
 *
 * One journey, in order: an owner registers, creates a community, draws a polygon on the map
 * and lists it, the rating completes, they upload documents, an admin approves them in the
 * review queue, the owner launches the IPO, a second account registers, buys and sells, the
 * portfolio and the community's home reflect it, and everyone signs out. Along the way it
 * checks authorization in the browser: anonymous visitors browse but can't trade, and the
 * investor is refused (403) on Steward and admin actions.
 */
import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { ADMIN_EMAIL, ADMIN_PASSWORD, WEB_ORIGIN } from "./env";
import { uniquePng } from "./png";

// Unique per run, so the suite never collides with an earlier run's accounts or names.
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const OWNER = {
  name: `Owner ${RUN}`,
  email: `owner-${RUN}@naturex.test`,
  password: `owner pw ${RUN}!`,
};
const INVESTOR = {
  name: `Investor ${RUN}`,
  email: `investor-${RUN}@naturex.test`,
  password: `investor pw ${RUN}!`,
};
const COMMUNITY = `Riverkeepers ${RUN}`;
const SITE = `Cloud Forest ${RUN}`;
// Somewhere in Kenya, far from the curated sites, a little different each run.
const CENTER = `${(0.2 + Math.random()).toFixed(4)}, ${(37 + Math.random()).toFixed(4)}`;

/** Rating runs are async (queued, then a worker); with mocks they take seconds. */
const RATING_TIMEOUT = 120_000;

/** A fresh browser session that never leaves the machine (map tiles etc. are refused). */
async function newSession(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: WEB_ORIGIN });
  await context.route(
    /^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/,
    (route) => route.abort(),
  );
  return context;
}

async function register(
  page: Page,
  person: { name: string; email: string; password: string },
): Promise<void> {
  await page.getByLabel("Display name").fill(person.name);
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Create account" }).click();
}

async function signOut(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: `Account: ${name}` }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByText("You're signed out")).toBeVisible();
  const me = await page.request.get("/api/me");
  expect(me.status()).toBe(401);
}

/** The API through the frontend's same-origin proxy, with this session's cookie. */
function apiWrite(
  page: Page,
  method: "POST" | "PATCH",
  path: string,
  data: Buffer | Record<string, unknown>,
  contentType = "application/json",
): Promise<APIResponse> {
  return page.request.fetch(`/api${path}`, {
    method,
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

test("real accounts: list, verify, launch, trade, and sign out", async ({
  browser,
}) => {
  const ownerContext = await newSession(browser);
  const owner = await ownerContext.newPage();
  let communityId = "";
  let assetId = "";
  let ipoPath = "";

  await test.step("the owner registers and creates a community", async () => {
    await owner.goto("/register?next=/steward");
    await register(owner, OWNER);
    await expect(
      owner.getByRole("heading", { name: "Start a community", level: 1 }),
    ).toBeVisible();
    await owner.getByLabel("Community name").fill(COMMUNITY);
    await owner.getByLabel("Country (optional)").fill("KE");
    await owner.getByRole("button", { name: "Create community" }).click();
    await expect(
      owner.getByRole("heading", { name: COMMUNITY, level: 1 }),
    ).toBeVisible();
    communityId = new URL(owner.url()).searchParams.get("community") ?? "";
    expect(communityId).not.toBe("");
  });

  await test.step("the owner draws the land on the map and saves a draft", async () => {
    await owner
      .getByRole("region", { name: "List your land" })
      .getByRole("link", { name: "List your land" })
      .click();
    await owner.getByLabel("Site name").fill(SITE);
    await owner
      .getByRole("checkbox", { name: /has the right to list this land/ })
      .check();
    await owner.getByRole("button", { name: "Continue to boundary" }).click();

    // Find the land by its coordinates, then click four corners on the real Leaflet map.
    const map = owner.getByRole("application", { name: /^Boundary map/ });
    await expect(map.getByRole("button", { name: "Zoom in" })).toBeVisible();
    await owner.getByRole("textbox", { name: "Coordinates" }).fill(CENTER);
    await owner.getByRole("button", { name: "Go there" }).click();
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
    await expect(owner.getByText("4 corners")).toBeVisible();
    await expect(
      owner.getByText("Shape, size and overlap look right."),
    ).toBeVisible();
    await owner.getByRole("button", { name: "Save draft" }).click();
    await expect(
      owner.getByRole("heading", { name: "Ready to rate" }),
    ).toBeVisible();
  });

  await test.step("the rating runs and the land is listed", async () => {
    await owner.getByRole("button", { name: "Rate this site" }).click();
    await expect(
      owner.getByRole("heading", { name: `${SITE} is listed` }),
    ).toBeVisible({ timeout: RATING_TIMEOUT });
    await expect(owner.getByRole("img", { name: /^Grade / })).toBeVisible();
    // USE_MOCKS: the UI must say the metrics are placeholders.
    await expect(owner.getByText(/^Mock data: this rating used/)).toBeVisible();
    const href = await owner
      .getByRole("link", { name: "See the public page" })
      .getAttribute("href");
    assetId = href?.split("/").pop() ?? "";
    expect(assetId).not.toBe("");
  });

  await test.step("the opening offer waits for verification", async () => {
    await owner.getByRole("link", { name: "Set up the opening offer" }).click();
    await expect(owner.getByText("Verification comes first")).toBeVisible();
    await expect(
      owner.getByRole("button", { name: "Launch opening offer" }),
    ).toBeDisabled();
    ipoPath = new URL(owner.url()).pathname + new URL(owner.url()).search;
    await owner.getByRole("link", { name: "Verify this listing" }).click();
  });

  await test.step("the owner uploads documents and submits them", async () => {
    await expect(
      owner.getByRole("heading", { name: "Not verified yet" }),
    ).toBeVisible();
    const upload = owner.getByRole("region", { name: "Upload a document" });
    for (const [type, file] of [
      ["Land title", "land-title.png"],
      ["Assembly minutes (consent)", "assembly-minutes.png"],
    ]) {
      await upload.getByRole("combobox", { name: "What is it?" }).click();
      await owner.getByRole("option", { name: type, exact: true }).click();
      await upload.getByLabel("File").setInputFiles({
        name: file,
        mimeType: "image/png",
        buffer: uniquePng(),
      });
      await upload
        .getByRole("checkbox", { name: /authorised to share this document/ })
        .check();
      await upload.getByRole("button", { name: "Upload document" }).click();
      await expect(upload.getByText(`Uploaded: ${type}.`)).toBeVisible();
    }
    const documents = owner.getByRole("region", { name: "Your documents" });
    await documents.getByRole("checkbox", { name: /^Land title/ }).check();
    await documents
      .getByRole("checkbox", { name: /^Assembly minutes \(consent\)/ })
      .check();
    await documents
      .getByRole("button", { name: "Submit 2 documents for review" })
      .click();
    await expect(
      owner.getByRole("heading", { name: "Waiting for a reviewer" }),
    ).toBeVisible();
  });

  const adminContext = await newSession(browser);
  const admin = await adminContext.newPage();

  await test.step("an admin approves the listing in the review queue", async () => {
    await admin.goto("/login?next=/admin/verifications");
    await admin.getByLabel("Email").fill(ADMIN_EMAIL);
    await admin.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await admin.getByRole("button", { name: "Sign in" }).click();
    await expect(
      admin.getByRole("heading", { name: "Verification queue" }),
    ).toBeVisible();
    await admin.getByRole("link", { name: `Review ${SITE}` }).click();
    await expect(
      admin.getByRole("heading", { name: SITE, level: 1 }),
    ).toBeVisible();
    const checks = admin
      .getByRole("region", { name: "Automated checks" })
      .getByRole("listitem");
    await expect(checks).toHaveCount(4);
    for (const check of await checks.all()) {
      await expect(check).toContainText("Passed");
    }
    await admin
      .getByLabel("Reason or note for the steward")
      .fill("Title and assembly minutes match the boundary.");
    await admin.getByRole("button", { name: "Approve" }).click();
    await expect(
      admin.getByRole("alert").filter({ hasText: "Decision recorded" }),
    ).toContainText("Approved. The listing is verified");
  });

  await test.step("the owner launches the IPO", async () => {
    await owner.goto(ipoPath);
    const launch = owner.getByRole("button", { name: "Launch opening offer" });
    await expect(launch).toBeEnabled();
    await launch.click();
    const confirm = owner.getByRole("dialog", {
      name: `Open ${SITE} to supporters?`,
    });
    await confirm.getByRole("button", { name: /^Launch at \$/ }).click();
    await expect(
      owner.getByRole("heading", { name: `${SITE} is open to supporters` }),
    ).toBeVisible();
  });

  const investorContext = await newSession(browser);
  const investor = await investorContext.newPage();

  await test.step("an anonymous visitor browses but can't trade", async () => {
    await investor.goto("/");
    const sites = investor.getByRole("region", { name: "All sites" });
    await sites.getByRole("link", { name: new RegExp(SITE) }).click();
    await expect(
      investor.getByRole("heading", { name: SITE, level: 1 }),
    ).toBeVisible();
    await expect(
      investor.getByRole("region", { name: "How this listing was verified" }),
    ).toContainText("Verified");
    const panel = tradePanel(investor);
    await expect(
      panel.getByRole("link", { name: "Sign in to trade" }),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Buy/ })).toHaveCount(0);
    await expectRefused(
      await apiWrite(investor, "POST", "/orders", {
        asset_id: assetId,
        side: "buy",
        qty: 1,
      }),
      401,
      "auth_required",
    );
  });

  let paid = "";

  await test.step("a second account registers, buys and sells", async () => {
    await tradePanel(investor)
      .getByRole("link", { name: "Sign in to trade" })
      .click();
    await investor.getByRole("link", { name: "Create an account" }).click();
    await register(investor, INVESTOR);
    await expect(investor).toHaveURL(new RegExp(`/asset/${assetId}$`));

    const panel = tradePanel(investor);
    const status = panel.getByRole("status");
    await panel.getByRole("textbox", { name: "Units" }).fill("100");
    await panel.getByRole("button", { name: "Buy 100 units" }).click();
    await expect(status).toContainText("Bought 100 units");
    paid = /You paid (\$[\d,]+\.\d{2})/.exec(
      (await status.textContent()) ?? "",
    )![1];

    await panel.getByRole("tab", { name: "Sell units" }).click();
    await panel.getByRole("textbox", { name: "Units" }).fill("40");
    await panel.getByRole("button", { name: "Sell 40 units" }).click();
    await expect(status).toContainText("Sold 40 units");
    await expect(status).toContainText("60 units held");
  });

  await test.step("the portfolio shows the stake", async () => {
    await investor.getByRole("link", { name: "Your stakes" }).click();
    await expect(
      investor.getByRole("heading", { name: "Your stakes", level: 1 }),
    ).toBeVisible();
    const row = investor.getByRole("row", { name: new RegExp(SITE) });
    await expect(row.getByRole("cell").nth(2)).toHaveText("60");
    await expect(row.getByRole("link", { name: SITE })).toHaveAttribute(
      "href",
      `/asset/${assetId}`,
    );
  });

  await test.step("the investor is refused Steward and admin actions", async () => {
    // The Steward app shows a non-member none of the community's pages or controls...
    await investor.goto(ipoPath);
    await expect(
      investor.getByRole("heading", { name: "Start a community", level: 1 }),
    ).toBeVisible();
    await expect(
      investor.getByRole("button", { name: "Launch opening offer" }),
    ).toHaveCount(0);
    // ...and the API refuses its Steward actions with a 403 and the policy's reason.
    await expectRefused(
      await apiWrite(investor, "POST", `/assets/${assetId}/ipo`, {
        total_shares: 1_000_000,
        retained_pct: "51",
        expected_price: "1",
      }),
      403,
      "owner_only",
    );
    await expectRefused(
      await apiWrite(investor, "PATCH", `/communities/${communityId}`, {
        name: `Taken over ${RUN}`,
      }),
      403,
      "owner_only",
    );
    await expectRefused(
      await apiWrite(
        investor,
        "POST",
        `/assets/${assetId}/documents?doc_type=title`,
        uniquePng(),
        "image/png",
      ),
      403,
      "members_only",
    );
    // The review queue is admin-only: a 403 message, not the queue.
    await investor.goto("/admin/verifications");
    await expect(
      investor
        .getByRole("alert")
        .filter({ hasText: "The control room is for platform admins" }),
    ).toBeVisible();
    await expect(
      investor.getByRole("heading", { name: "Verification queue" }),
    ).toHaveCount(0);
  });

  await test.step("the community's home reflects the supporter", async () => {
    await owner.goto(`/steward?community=${communityId}`);
    await expect(
      owner
        .getByRole("region", { name: SITE })
        .getByText("100 of 490,000 units taken by supporters"),
    ).toBeVisible();
    await expect(
      owner.getByRole("region", { name: "Supporters" }),
    ).toContainText("1 supporter hold 60 units");
    await expect(
      owner.getByRole("region", { name: "Community fund" }),
    ).toContainText(paid);
  });

  await test.step("everyone signs out", async () => {
    await signOut(owner, OWNER.name);
    await expect(owner).toHaveURL(/\/login\?next=/);
    await investor.goto("/portfolio");
    await signOut(investor, INVESTOR.name);
    await expect(investor).toHaveURL(/\/login\?next=%2Fportfolio/);
    await signOut(admin, "E2E Admin");
  });

  await Promise.all([
    ownerContext.close(),
    adminContext.close(),
    investorContext.close(),
  ]);
});
