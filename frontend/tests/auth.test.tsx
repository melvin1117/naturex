import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "@/components/account-menu";
import { AuthForm } from "@/components/proto/auth-form";
import { DemoBar } from "@/components/proto/demo-bar";
import { TourProvider } from "@/components/proto/tour";
import { RequireAccount } from "@/components/require-account";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer, type DataLayer } from "@/lib/data-layer";
import { usePortfolio, useWorld } from "@/lib/hooks";
import { PrototypeProvider, usePrototype } from "@/lib/prototype/store";

import {
  BASE,
  fakeBackend,
  json,
  sequence,
  SIGNED_IN_WORLD,
  WORLD,
} from "./lib/helpers";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
}));
const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  // jsdom lacks these; Radix menus ask for them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/";
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

type Routes = Parameters<typeof fakeBackend>[0];

function setup(ui: ReactNode, routes: Routes = {}) {
  const backend = fakeBackend({ "GET /world": () => json(WORLD), ...routes });
  const layer: DataLayer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
  });
  const utils = render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>{ui}</TourProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
  return { ...utils, backend, layer };
}

function fill(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const submit = (name: RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

describe("AuthForm", () => {
  it("posts, so a submit before hydration never puts the password in the URL", () => {
    const { container } = setup(<AuthForm mode="login" />);
    expect(container.querySelector("form")).toHaveAttribute("method", "post");
  });

  it("uses the right autocomplete hints and shows or hides the password", () => {
    setup(<AuthForm mode="register" />);
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "autocomplete",
      "email",
    );
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(password).toHaveAttribute("type", "password");
  });

  it("checks the fields before sending anything", async () => {
    const { backend } = setup(<AuthForm mode="register" />);
    fill("Email", "rosa@");
    fill("Password", "short");
    submit(/create account/i);

    expect(await screen.findByText("Enter a display name.")).toBeVisible();
    expect(
      screen.getByText("Use at least 10 characters for your password."),
    ).toBeVisible();
    expect(screen.getByLabelText("Display name")).toHaveFocus();
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(backend.calls("POST /auth/register")).toBe(0);
  });

  it("signs in, re-reads the world and returns to a safe next path", async () => {
    const { backend, layer } = setup(
      <AuthForm mode="login" next="/portfolio" />,
      {
        "GET /world": sequence(
          () => json(WORLD),
          () => json(SIGNED_IN_WORLD),
        ),
        "POST /auth/login": () => json(SIGNED_IN_WORLD.me),
      },
    );
    await waitFor(() => expect(backend.calls("GET /world")).toBe(1));
    fill("Email", "rosa@example.org");
    fill("Password", "correct horse battery");
    submit(/^sign in$/i);

    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/portfolio"),
    );
    expect(backend.calls("GET /world")).toBe(2);
    expect(layer.session.getSnapshot().world?.me?.name).toBe("Rosa");
    const login = backend.requests.find((r) => r.url.endsWith("/auth/login"))!;
    expect(login.credentials).toBe("same-origin");
    expect(await login.json()).toEqual({
      email: "rosa@example.org",
      password: "correct horse battery",
    });
    // The session is the HttpOnly cookie only: nothing lands in JS-readable storage.
    const stored = JSON.stringify({
      ...window.localStorage,
      ...window.sessionStorage,
    });
    expect(stored).not.toContain("correct horse battery");
    expect(document.cookie).toBe("");
  });

  it("never follows an open redirect after sign-in", async () => {
    setup(<AuthForm mode="login" next="//evil.com" />, {
      "GET /world": sequence(
        () => json(WORLD),
        () => json(SIGNED_IN_WORLD),
      ),
      "POST /auth/login": () => json(SIGNED_IN_WORLD.me),
    });
    fill("Email", "rosa@example.org");
    fill("Password", "correct horse battery");
    submit(/^sign in$/i);
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(router.replace).not.toHaveBeenCalledWith(
      expect.stringContaining("evil"),
    );
  });

  it("disables submit while the request is pending", async () => {
    let respond!: (response: Response) => void;
    setup(<AuthForm mode="login" />, {
      "POST /auth/login": () => new Promise<Response>((r) => (respond = r)),
    });
    fill("Email", "rosa@example.org");
    fill("Password", "whatever-password");
    submit(/^sign in$/i);
    const pending = await screen.findByRole("button", { name: /signing in/i });
    expect(pending).toBeDisabled();
    await act(async () =>
      respond(
        json({ detail: "Email or password is incorrect" }, { status: 401 }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: /^sign in$/i }),
    ).toBeEnabled();
  });

  it.each([
    [
      "login",
      "POST /auth/login",
      () => json({ detail: "Email or password is incorrect" }, { status: 401 }),
      "Email or password is incorrect.",
    ],
    [
      "login",
      "POST /auth/login",
      () =>
        json(
          { detail: "too_many_attempts" },
          { status: 429, headers: { "Retry-After": "600" } },
        ),
      "Too many attempts. For your security, wait 10 minutes and try again.",
    ],
    [
      "register",
      "POST /auth/register",
      () =>
        json(
          { detail: "This email can't be used to create an account" },
          { status: 409 },
        ),
      "This email can't be used to create an account. If it's yours, sign in instead.",
    ],
    [
      "register",
      "POST /auth/register",
      () =>
        json(
          {
            detail: [
              {
                loc: ["body", "password"],
                type: "string_too_short",
                msg: "String should have at least 10 characters",
              },
            ],
          },
          { status: 422 },
        ),
      "Use at least 10 characters for your password.",
    ],
    [
      "login",
      "POST /auth/login",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "Can't reach NatureX. Check your connection and try again.",
    ],
  ] as const)(
    "%s shows a clear message for %s failures",
    async (mode, route, handler, message) => {
      setup(<AuthForm mode={mode} />, { [route]: handler });
      if (mode === "register") fill("Display name", "Rosa");
      fill("Email", "rosa@example.org");
      fill("Password", "a-long-enough-password");
      submit(mode === "register" ? /create account/i : /^sign in$/i);
      expect(await screen.findByText(message)).toBeVisible();
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("carries next to the other auth page, but only when it's safe", () => {
    setup(<AuthForm mode="login" next="/steward/list" />);
    expect(
      screen.getByRole("link", { name: "Create an account" }),
    ).toHaveAttribute("href", "/register?next=%2Fsteward%2Flist");
  });

  it("sends a visitor who is already signed in straight on", async () => {
    setup(<AuthForm mode="login" next="/admin" />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin"));
  });
});

describe("RequireAccount", () => {
  const Secret = () => <p>Your stakes</p>;

  it("redirects anonymous visitors to sign in and back", async () => {
    window.history.replaceState(null, "", "/portfolio?tab=impact");
    setup(
      <RequireAccount>
        <Secret />
      </RequireAccount>,
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        "/login?next=%2Fportfolio%3Ftab%3Dimpact",
      ),
    );
    expect(screen.queryByText("Your stakes")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/sign in/i);
  });

  it("shows the page to a signed-in account", async () => {
    setup(
      <RequireAccount>
        <Secret />
      </RequireAccount>,
      { "GET /world": () => json(SIGNED_IN_WORLD) },
    );
    expect(await screen.findByText("Your stakes")).toBeVisible();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("explains a 403 instead of looping when the account isn't an admin", async () => {
    setup(
      <RequireAccount admin>
        <Secret />
      </RequireAccount>,
      { "GET /world": () => json(SIGNED_IN_WORLD) },
    );
    expect(
      await screen.findByText("The control room is for platform admins"),
    ).toBeVisible();
    expect(screen.queryByText("Your stakes")).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("lets an admin into admin routes", async () => {
    setup(
      <RequireAccount admin>
        <Secret />
      </RequireAccount>,
      {
        "GET /world": () =>
          json({
            ...SIGNED_IN_WORLD,
            me: { ...SIGNED_IN_WORLD.me, is_admin: true },
          }),
      },
    );
    expect(await screen.findByText("Your stakes")).toBeVisible();
  });

  it("keeps the scripted demo open after the visitor picks a persona", async () => {
    function EnterDemo() {
      const { setPersona } = usePrototype();
      return <button onClick={() => setPersona("steward")}>Explore</button>;
    }
    setup(
      <>
        <EnterDemo />
        <RequireAccount>
          <Secret />
        </RequireAccount>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    expect(await screen.findByText("Your stakes")).toBeVisible();
    expect(window.sessionStorage.getItem("nx-prototype-demo")).toBe("1");
  });
});

describe("AccountMenu", () => {
  function Viewer() {
    const { world } = useWorld();
    const portfolio = usePortfolio();
    return (
      <p>
        Viewer {world?.me?.name ?? "anonymous"}, cash{" "}
        {portfolio.data?.cash_balance ?? "none"}
      </p>
    );
  }

  it("offers sign-in, with a return path, to anonymous visitors", async () => {
    nav.pathname = "/asset/abc";
    setup(<AccountMenu />);
    expect(
      await screen.findByRole("link", { name: "Sign in" }),
    ).toHaveAttribute("href", "/login?next=%2Fasset%2Fabc");
  });

  it("shows the account and signs out, resetting the world and cache", async () => {
    const { backend, layer } = setup(
      <>
        <AccountMenu />
        <Viewer />
      </>,
      {
        "GET /world": sequence(
          () => json(SIGNED_IN_WORLD),
          () => json(WORLD),
        ),
        "GET /portfolio": sequence(
          () => json({ cash_balance: "9000.00", holdings: [], impact: {} }),
          () => json({ detail: "auth_required" }, { status: 401 }),
        ),
        "POST /auth/logout": () => new Response(null, { status: 204 }),
      },
    );
    expect(await screen.findByText("Viewer Rosa, cash 9000.00")).toBeVisible();

    const trigger = screen.getByRole("button", { name: "Account: Rosa" });
    expect(trigger).toHaveTextContent("Rosa");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByText("rosa@example.org")).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));

    expect(await screen.findByRole("link", { name: "Sign in" })).toBeVisible();
    expect(backend.calls("POST /auth/logout")).toBe(1);
    expect(backend.calls("GET /world")).toBe(2);
    expect(layer.session.getSnapshot().world?.me).toBeNull();
    // The cache was reset: Rosa's answer is gone and refetched as the anonymous visitor.
    expect(
      await screen.findByText("Viewer anonymous, cash none"),
    ).toBeVisible();
    await waitFor(() => expect(backend.calls("GET /portfolio")).toBe(2));
  });
});

describe("DemoBar", () => {
  it("shows the persona switcher only without a signed-in account", async () => {
    setup(<DemoBar />);
    expect(
      await screen.findByRole("radiogroup", { name: "Switch persona" }),
    ).toBeVisible();
  });

  it("shows a signed-in account only the sandbox notice", async () => {
    const { backend } = setup(<DemoBar />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
    });
    await waitFor(() => expect(backend.calls("GET /world")).toBe(1));
    expect(
      await screen.findByRole("region", { name: "Sandbox notice" }),
    ).toHaveTextContent("Sandbox: play money, not a real security.");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByText(/reset my demo/i)).not.toBeInTheDocument();
  });
});
