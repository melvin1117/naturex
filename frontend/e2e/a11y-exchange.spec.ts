/**
 * T48 · Accessibility check of the Exchange on the real stack: axe (WCAG 2.2 A/AA rules) on the
 * Marketplace, an asset page and the portfolio, anonymous and signed in, on desktop and at
 * 390 px. Fails on any serious or critical violation, and on horizontal overflow at 390 px.
 */
import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { randomUUID } from "node:crypto";

import { WEB_ORIGIN } from "./env";

const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const INVESTOR = {
  name: `A11y ${RUN}`,
  email: `a11y-${RUN}@naturex.test`,
  password: `a11y pw ${RUN}!`,
};
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "390 px", width: 390, height: 844 },
] as const;

const sessions: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(sessions.splice(0).map((context) => context.close()));
});

/** A browser session that never leaves the machine (map tiles etc. are refused). */
async function newSession(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: WEB_ORIGIN });
  sessions.push(context);
  await context.route(
    /^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/,
    (route) => route.abort(),
  );
  return context.newPage();
}

/** Serious and critical axe violations, one line each, so a failure says what and where. */
async function blockingViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(WCAG)
    .analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(", ")}`,
    );
}

async function checkPage(
  page: Page,
  path: string,
  ready: (page: Page) => Promise<void>,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto(path);
    await ready(page);
    expect(
      await blockingViolations(page),
      `${path} at ${viewport.name}`,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(
      overflow,
      `${path} overflows at ${viewport.name}`,
    ).toBeLessThanOrEqual(0);
  }
}

const marketplaceReady = async (page: Page) => {
  await expect(page.locator("a[href^='/asset/']").first()).toBeVisible();
};
const assetReady = async (page: Page) => {
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("What the land does each year")).toBeVisible();
};

test("the Exchange has no serious accessibility violations", async ({
  browser,
}) => {
  const page = await newSession(browser);

  await test.step("anonymous: Marketplace and an asset page", async () => {
    await checkPage(page, "/", marketplaceReady);
    const href = await page
      .locator("a[href^='/asset/']")
      .first()
      .getAttribute("href");
    expect(href).toBeTruthy();
    await checkPage(page, href!, assetReady);
  });

  await test.step("signed in: Marketplace, asset page and portfolio", async () => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto("/register?next=/portfolio");
    await page.getByLabel("Display name").fill(INVESTOR.name);
    await page.getByLabel("Email").fill(INVESTOR.email);
    await page.getByLabel("Password", { exact: true }).fill(INVESTOR.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("button", { name: `Account: ${INVESTOR.name}` }),
    ).toBeVisible();

    await checkPage(page, "/", marketplaceReady);
    const href = await page
      .locator("a[href^='/asset/']")
      .first()
      .getAttribute("href");
    await checkPage(page, href!, async (p) => {
      await assetReady(p);
      await expect(
        p.getByRole("button", { name: /^Buy \d+ units$/ }),
      ).toBeVisible();
    });
    await checkPage(page, "/portfolio", async (p) => {
      await expect(
        p.getByRole("heading", { level: 1, name: "Your stakes" }),
      ).toBeVisible();
      await expect(p.getByText("Play money available")).toBeVisible();
    });
  });
});
