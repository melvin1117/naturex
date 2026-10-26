/**
 * T48 · Accessibility check of the sandbox on the real stack (ADR-0008): axe (WCAG 2.2 A/AA
 * rules, plus label-in-name) on the welcome, the story, the Marketplace, a site page with its
 * Agent Trace open, a missing site, Your stakes empty and after a buy, Communities, a
 * community's page, List land, the community's settings and the Reviewer's Reviews, on desktop
 * and at 390 px, with reduced motion. Fails on any serious or
 * critical violation, and on horizontal overflow at 390 px.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

import { WEB_ORIGIN } from "./env";
import { closeSessions, newSession } from "./session";

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
    // Tagged experimental, so the tags alone skip it: a control's name must contain its text.
    .options({ rules: { "label-content-name-mismatch": { enabled: true } } })
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
  await expect(
    page.locator("a[href^='/sandbox/asset/']").first(),
  ).toBeVisible();
};
const assetReady = async (page: Page) => {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("What the land does each year")).toBeVisible();
};
const stakesReady = async (page: Page) => {
  await expect(
    page.getByRole("heading", { level: 1, name: "Your stakes" }),
  ).toBeVisible();
  await expect(page.getByText(/^You (have|back) /)).toBeVisible();
};

async function firstAssetHref(page: Page): Promise<string> {
  const href = await page
    .locator("a[href^='/sandbox/asset/']")
    .first()
    .getAttribute("href");
  expect(href).toBeTruthy();
  return href!;
}

/** Be someone else in this sandbox, from the header's person menu. */
async function become(page: Page, person: "Rosa" | "Arjun" | "Reviewer") {
  await page.getByRole("button", { name: /^Viewing as / }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(person) }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`^Viewing as ${person}`) }),
  ).toBeVisible();
}

test("the sandbox has no serious accessibility violations", async ({
  browser,
}) => {
  const page = await newPage(browser);
  let asset = "";

  await test.step("the welcome and the story", async () => {
    await checkPage(page, "/", async (p) => {
      await expect(
        p.getByRole("heading", { level: 1, name: "Welcome to WildWorth." }),
      ).toBeVisible();
    });
    await checkPage(page, "/how", async (p) => {
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    });
  });

  await test.step("the Marketplace, a site with its Agent Trace, a missing site", async () => {
    await checkPage(page, "/sandbox", marketplaceReady);
    asset = await firstAssetHref(page);
    await checkPage(page, asset, assetReady);
    await page
      .getByRole("button", { name: "How it was rated" })
      .first()
      .click();
    await expect(
      page.getByRole("dialog", { name: /^How .* was rated$/ }),
    ).toBeVisible();
    await expectNoBlockingViolations(page, `${asset} with its Agent Trace`);
    await page.keyboard.press("Escape");
    await checkPage(
      page,
      "/sandbox/asset/00000000-0000-0000-0000-000000000000",
      async (p) => {
        await expect(
          p.getByRole("heading", { name: "Site not found" }),
        ).toBeVisible();
      },
    );
  });

  await test.step("the bar keeps one top row on a 360 px phone", async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto("/sandbox");
    await marketplaceReady(page);
    const logo = await page
      .getByRole("link", { name: "WildWorth, Marketplace" })
      .boundingBox();
    const who = await page
      .getByRole("button", { name: /^Viewing as / })
      .boundingBox();
    const middle = (box: { y: number; height: number }) =>
      box.y + box.height / 2;
    expect(Math.abs(middle(logo!) - middle(who!))).toBeLessThan(4);
    await page.setViewportSize(DESKTOP);
  });

  await test.step("Your stakes, empty then after a buy", async () => {
    await checkPage(page, "/sandbox/portfolio", async (p) => {
      await stakesReady(p);
      await expect(
        p.getByRole("link", { name: "Back your first site" }),
      ).toBeVisible();
    });
    await page.goto(asset);
    await assetReady(page);
    const site = await page.getByRole("heading", { level: 1 }).innerText();
    const panel = page.getByRole("region", { name: "Back this site" });
    const buy = panel.getByRole("button", { name: "Buy 10 units" });
    await expect(buy).not.toHaveAttribute("aria-disabled", "true");
    await buy.click();
    await expect(panel.getByText(/Stake added: 10 units/)).toBeVisible();
    await expectNoBlockingViolations(page, `${asset} with a receipt`);
    await checkPage(page, "/sandbox/portfolio", async (p) => {
      await stakesReady(p);
      await expect(p.getByRole("link", { name: site })).toBeVisible();
    });
  });

  await test.step("Communities and a community's page", async () => {
    await become(page, "Rosa");
    await checkPage(page, "/sandbox/steward", async (p) => {
      await expect(
        p
          .getByRole("list", { name: "Your communities" })
          .getByRole("link")
          .first(),
      ).toBeVisible();
    });
    const community = await page
      .getByRole("list", { name: "Your communities" })
      .getByRole("link")
      .first()
      .getAttribute("href");
    expect(community).toMatch(/[?&]community=/);
    await checkPage(page, community!, async (p) => {
      await expect(
        p.getByRole("link", { name: "All communities" }),
      ).toBeVisible();
      await expect(
        p.getByRole("link", { name: "List more land" }),
      ).toBeVisible();
    });
    const id = new URL(community!, WEB_ORIGIN).searchParams.get("community");
    await checkPage(
      page,
      `/sandbox/steward/list?community=${id}`,
      async (p) => {
        await expect(p.getByLabel("Site name")).toBeVisible();
      },
    );
    await checkPage(
      page,
      `/sandbox/steward/community?community=${id}`,
      async (p) => {
        await expect(p.getByLabel("Community name")).toBeVisible();
      },
    );
  });

  await test.step("the Reviewer's Reviews", async () => {
    await become(page, "Reviewer");
    await checkPage(page, "/sandbox/admin/verifications", async (p) => {
      await expect(
        p.getByRole("heading", { level: 1, name: "Reviews" }),
      ).toBeVisible();
    });
  });
});
