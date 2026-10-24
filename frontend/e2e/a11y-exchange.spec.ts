/**
 * T48 · Accessibility check of the Exchange on the real stack: axe (WCAG 2.2 A/AA rules) on the
 * Marketplace, an asset page and the portfolio, anonymous and signed in, on desktop and at
 * 390 px, with reduced motion. Also covers a site that doesn't exist, the empty portfolio,
 * the portfolio and asset page after a buy, and the asset tab bar at 320 px. Fails on any
 * serious or critical violation, and on horizontal overflow at 390 px.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

import { randomUUID } from "node:crypto";

import { closeSessions, newSession, register } from "./session";

const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const INVESTOR = {
  name: `A11y ${RUN}`,
  email: `a11y-${RUN}@wildworth.test`,
  password: `a11y pw ${RUN}!`,
};
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEWPORTS = [
  { name: "desktop", ...DESKTOP },
  { name: "390 px", ...PHONE },
] as const;

test.afterEach(closeSessions);

async function newPage(browser: Browser): Promise<Page> {
  const context = await newSession(browser, { reducedMotion: "reduce" });
  return context.newPage();
}

/** Serious and critical axe violations on the page as it is now, one line each. */
async function expectNoBlockingViolations(
  page: Page,
  where: string,
): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(WCAG)
    .analyze();
  const blocking = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(", ")}`,
    );
  expect(blocking, where).toEqual([]);
}

/** Axe and overflow at each viewport; ends at desktop size. */
async function checkPage(
  page: Page,
  path: string,
  ready: (page: Page) => Promise<void>,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto(path);
    await ready(page);
    await expectNoBlockingViolations(page, `${path} at ${viewport.name}`);
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
  await page.setViewportSize(DESKTOP);
}

const marketplaceReady = async (page: Page) => {
  await expect(page.locator("a[href^='/asset/']").first()).toBeVisible();
};
const assetReady = async (page: Page) => {
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("What the land does each year")).toBeVisible();
};
const portfolioReady = async (page: Page) => {
  await expect(
    page.getByRole("heading", { level: 1, name: "Your stakes" }),
  ).toBeVisible();
  await expect(page.getByText("Play money available")).toBeVisible();
};

async function firstAssetHref(page: Page): Promise<string> {
  const href = await page
    .locator("a[href^='/asset/']")
    .first()
    .getAttribute("href");
  expect(href).toBeTruthy();
  return href!;
}

test("the Exchange has no serious accessibility violations", async ({
  browser,
}) => {
  const page = await newPage(browser);
  let asset = "";

  await test.step("anonymous: Marketplace, an asset page and a missing site", async () => {
    await checkPage(page, "/", marketplaceReady);
    asset = await firstAssetHref(page);
    await checkPage(page, asset, assetReady);
    await checkPage(
      page,
      "/asset/00000000-0000-0000-0000-000000000000",
      async (p) => {
        await expect(
          p.getByRole("heading", { name: "Site not found" }),
        ).toBeVisible();
      },
    );
  });

  await test.step("320 px: the asset tabs scroll inside their bar", async () => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(asset);
    await assetReady(page);
    await expectNoBlockingViolations(page, `${asset} at 320 px`);
    const tabs = page.getByRole("tablist").first();
    const bar = await tabs.evaluate((list) => {
      const scroller = list.parentElement!;
      return {
        scrolls: scroller.scrollWidth > scroller.clientWidth,
        withinPage: scroller.getBoundingClientRect().right <= window.innerWidth,
        fitsInPill: list.scrollWidth <= list.getBoundingClientRect().width + 1,
      };
    });
    expect(bar, "the tab bar scrolls; no tab is squashed").toEqual({
      scrolls: true,
      withinPage: true,
      fitsInPill: true,
    });
    // The keyboard reaches the last tab, and it scrolls into view.
    await page.getByRole("tab", { name: "Overview" }).focus();
    await page.keyboard.press("End");
    const ledger = page.getByRole("tab", { name: "The Record" });
    await expect(ledger).toBeFocused();
    // Sub-pixel layout can leave a hair outside.
    await expect(ledger).toBeInViewport({ ratio: 0.95 });
    await page.setViewportSize(DESKTOP);
  });

  await test.step("signed in: Marketplace, empty portfolio and asset page", async () => {
    await page.goto("/register?next=/portfolio");
    await register(page, INVESTOR);
    await expect(
      page.getByRole("button", { name: `Account: ${INVESTOR.name}` }),
    ).toBeVisible();

    await checkPage(page, "/portfolio", async (p) => {
      await portfolioReady(p);
      await expect(
        p.getByRole("link", { name: "Back your first site" }),
      ).toBeVisible();
    });
    await checkPage(page, "/", marketplaceReady);
    await checkPage(page, asset, async (p) => {
      await assetReady(p);
      await expect(
        p.getByRole("button", { name: /^Buy \d+ units$/ }),
      ).toBeVisible();
    });
  });

  await test.step("after a buy: the receipt and the portfolio's stakes", async () => {
    await page.goto(asset);
    await assetReady(page);
    const site = await page.getByRole("heading", { level: 1 }).innerText();
    const panel = page.getByRole("region", { name: "Back this site" });
    await panel.getByRole("button", { name: "Buy 10 units" }).click();
    await expect(panel.getByText(/Stake added: 10 units/)).toBeVisible();
    await expectNoBlockingViolations(page, `${asset} with a receipt`);

    await checkPage(page, "/portfolio", async (p) => {
      await portfolioReady(p);
      await expect(
        p.getByRole("heading", { level: 2, name: "Stakes" }),
      ).toBeVisible();
      // A card per stake at 390 px, the table on desktop: either way, the site is listed.
      await expect(
        p.getByRole("link", { name: site }).filter({ visible: true }).first(),
      ).toBeVisible();
    });
  });
});
