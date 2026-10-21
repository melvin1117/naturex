/**
 * Browser sessions and accounts shared by the E2E specs: every session stays on this machine
 * (map tiles etc. are refused) and is closed after its test, pass or fail.
 */
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "@playwright/test";

import { WEB_ORIGIN } from "./env";

export type Person = { name: string; email: string; password: string };

const sessions: BrowserContext[] = [];

/** A fresh browser session that never leaves the machine. */
export async function newSession(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: WEB_ORIGIN, ...options });
  sessions.push(context);
  await context.route(
    /^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/,
    (route) => route.abort(),
  );
  return context;
}

/** Closes every session opened since the last call; use in `test.afterEach`. */
export async function closeSessions(): Promise<void> {
  await Promise.all(sessions.splice(0).map((context) => context.close()));
}

/** Fills and submits the register form (the page must be on /register). */
export async function register(page: Page, person: Person): Promise<void> {
  await page.getByLabel("Display name").fill(person.name);
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Create account" }).click();
}
