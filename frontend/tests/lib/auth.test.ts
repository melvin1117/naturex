import { describe, expect, it } from "vitest";

import { ApiError, apiErrorFromResponse } from "@/lib/api/errors";
import {
  authFailure,
  initials,
  loginHref,
  protectedAccess,
  safeReturnPath,
  validateAuthInput,
  withNext,
} from "@/lib/auth";

import { SIGNED_IN_WORLD } from "./helpers";

const ME = SIGNED_IN_WORLD.me!;

describe("safeReturnPath", () => {
  it.each([
    ["/portfolio", "/portfolio"],
    ["/steward/list?step=2#map", "/steward/list?step=2#map"],
    ["/asset/abc", "/asset/abc"],
    ["/", "/"],
  ])("keeps the same-origin path %s", (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it.each([
    ["//evil.com"],
    ["//evil.com/portfolio"],
    ["///evil.com"],
    ["/\\evil.com"],
    ["\\\\evil.com"],
    ["/\\/evil.com"],
    ["https://evil.com"],
    ["http://localhost:3000/portfolio"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["evil.com"],
    ["portfolio"],
    ["/\t/evil.com"],
    ["/\n/evil.com"],
    [" /portfolio"],
    ["/port folio"],
    ["/login"],
    ["/login?next=/portfolio"],
    ["/register"],
    [""],
    [null],
    [undefined],
    ["/" + "a".repeat(3000)],
    // Dot segments and encodings that normalise or decode into another host.
    ["/.//evil.com"],
    ["/a/..//evil.com"],
    ["/%2e%2e//evil.com"],
    ["/%2E%2E//evil.com"],
    ["/././/evil.com"],
    ["/%2F%2Fevil.com"],
    ["/%2f/evil.com"],
    ["/%5Cevil.com"],
    ["/%E0%A4%A"],
  ])("rejects %j", (raw) => {
    expect(safeReturnPath(raw)).toBe("/");
  });

  it("normalises dot segments without leaving the site", () => {
    expect(safeReturnPath("/a/../../evil.com")).toBe("/evil.com");
    expect(safeReturnPath("/steward/./list")).toBe("/steward/list");
    expect(safeReturnPath("/asset/caf%C3%A9")).toBe("/asset/caf%C3%A9");
  });

  it("uses the fallback given", () => {
    expect(safeReturnPath("//evil.com", "/steward")).toBe("/steward");
  });
});

describe("loginHref and withNext", () => {
  it("carries a safe return path, encoded", () => {
    expect(loginHref("/portfolio")).toBe("/login?next=%2Fportfolio");
    expect(loginHref("/steward/list?x=1")).toBe(
      "/login?next=%2Fsteward%2Flist%3Fx%3D1",
    );
    expect(withNext("/register", "/admin")).toBe("/register?next=%2Fadmin");
  });

  it("drops unsafe or pointless return paths", () => {
    expect(loginHref("//evil.com")).toBe("/login");
    expect(loginHref("/")).toBe("/login");
    expect(loginHref(undefined)).toBe("/login");
    expect(withNext("/login", "https://evil.com")).toBe("/login");
  });
});

describe("protectedAccess", () => {
  const base = {
    status: "ready" as const,
    me: null,
    prototypeDemo: false,
    prototypeReady: true,
  };

  it("sends anonymous visitors to sign in once the world is known", () => {
    expect(protectedAccess(base)).toBe("sign-in");
    expect(protectedAccess({ ...base, status: "loading" })).toBe("checking");
    expect(protectedAccess({ ...base, prototypeReady: false })).toBe(
      "checking",
    );
    expect(protectedAccess({ ...base, status: "error" })).toBe("unavailable");
  });

  it("lets a signed-in account in, and admin routes only for admins", () => {
    expect(protectedAccess({ ...base, me: ME })).toBe("allowed");
    expect(protectedAccess({ ...base, me: ME, admin: true })).toBe("forbidden");
    expect(
      protectedAccess({ ...base, me: { ...ME, is_admin: true }, admin: true }),
    ).toBe("allowed");
  });

  it("keeps the scripted prototype demo open to anonymous visitors", () => {
    expect(protectedAccess({ ...base, prototypeDemo: true })).toBe("allowed");
    expect(protectedAccess({ ...base, prototypeDemo: true, admin: true })).toBe(
      "allowed",
    );
  });
});

describe("validateAuthInput", () => {
  const ok = {
    name: "Rosa",
    email: "rosa@example.org",
    password: "a".repeat(10),
  };

  it("accepts valid input", () => {
    expect(validateAuthInput("register", ok)).toEqual({});
    expect(validateAuthInput("login", { ...ok, password: "x" })).toEqual({});
  });

  it("counts code points, as the backend does, not UTF-16 units", () => {
    // 5 emoji are 10 UTF-16 units but 5 characters: too short for the backend.
    expect(
      validateAuthInput("register", { ...ok, password: "🌿".repeat(5) })
        .password,
    ).toBe("Use at least 10 characters for your password.");
    // 100 emoji are 200 UTF-16 units but 100 characters: within the 128 limit.
    expect(
      validateAuthInput("login", { ...ok, password: "🌿".repeat(100) }),
    ).toEqual({});
    expect(
      validateAuthInput("register", { ...ok, name: "🌿".repeat(80) }),
    ).toEqual({});
  });

  it("explains each missing or invalid field", () => {
    expect(
      validateAuthInput("register", { name: " ", email: "", password: "" }),
    ).toEqual({
      name: "Enter a display name.",
      email: "Enter your email address.",
      password: "Enter your password.",
    });
    expect(
      validateAuthInput("register", {
        ...ok,
        email: "rosa@",
        password: "short",
      }),
    ).toEqual({
      email: "Enter a valid email address, like name@example.org.",
      password: "Use at least 10 characters for your password.",
    });
    expect(
      validateAuthInput("login", { ...ok, password: "a".repeat(129) }).password,
    ).toBe("Use 128 characters or fewer for your password.");
    expect(
      validateAuthInput("register", { ...ok, name: "n".repeat(81) }).name,
    ).toBe("Use 80 characters or fewer for your display name.");
  });

  it("refuses a display name that contains the password", () => {
    const password = "correct-horse-battery-22";
    const message =
      "Your display name is public, so it can't contain your password.";
    for (const name of [
      password,
      `${password}Ana Investor`,
      `Ana ${password.toUpperCase()}`,
    ]) {
      expect(validateAuthInput("register", { ...ok, name, password })).toEqual({
        name: message,
      });
    }
    expect(
      validateAuthInput("register", { ...ok, name: "Correct Horse", password }),
    ).toEqual({});
    expect(
      validateAuthInput("login", { ...ok, name: password, password }),
    ).toEqual({});
  });

  it("finds the password in the trimmed name, ignoring its edge spaces and Unicode form", () => {
    const message =
      "Your display name is public, so it can't contain your password.";
    expect(
      validateAuthInput("register", {
        ...ok,
        name: "  hunter2hunter2  ",
        password: "  hunter2hunter2  ",
      }).name,
    ).toBe(message);
    expect(
      validateAuthInput("register", {
        ...ok,
        name: "fullwidth-pass Ana",
        password: "ｆｕｌｌｗｉｄｔｈ-pass",
      }).name,
    ).toBe(message);
  });

  it("doesn't check the name against a password of the wrong length", () => {
    expect(
      validateAuthInput("register", { ...ok, name: "Ana", password: "an" }),
    ).toEqual({ password: "Use at least 10 characters for your password." });
  });
});

describe("authFailure", () => {
  it("keeps wrong credentials generic", () => {
    const error = new ApiError(
      401,
      "x",
      null,
      "Email or password is incorrect",
    );
    expect(authFailure("login", error)).toEqual({
      form: "Email or password is incorrect.",
      fields: {},
    });
  });

  it("puts an unavailable email on the email field", () => {
    const error = new ApiError(
      409,
      "x",
      null,
      "This email can't be used to create an account",
    );
    expect(authFailure("register", error)).toEqual({
      form: null,
      fields: {
        email:
          "This email can't be used to create an account. If it's yours, sign in instead.",
      },
    });
  });

  it("shows the Retry-After wait when rate limited", () => {
    const at = (seconds: number | null) =>
      authFailure(
        "login",
        new ApiError(
          429,
          "x",
          "too_many_attempts",
          "too_many_attempts",
          seconds,
        ),
      ).form;
    expect(at(840)).toBe(
      "Too many attempts. For your security, wait 14 minutes and try again.",
    );
    expect(at(45)).toBe(
      "Too many attempts. For your security, wait 45 seconds and try again.",
    );
    expect(at(null)).toContain("a few minutes");
  });

  it("maps 422 field errors to the password rules", () => {
    const detail = [
      { loc: ["body", "password"], type: "string_too_short", msg: "..." },
      { loc: ["body", "email"], type: "value_error", msg: "..." },
    ];
    expect(
      authFailure("register", new ApiError(422, "x", null, detail)),
    ).toEqual({
      form: null,
      fields: {
        password: "Use at least 10 characters for your password.",
        email: "Enter a valid email address, like name@example.org.",
      },
    });
    expect(authFailure("register", new ApiError(422, "x", null, [])).form).toBe(
      "Some of the details you entered aren't valid.",
    );
    expect(
      authFailure(
        "register",
        new ApiError(422, "x", null, [
          { loc: ["body", "name"], type: "name_contains_password", msg: "." },
        ]),
      ),
    ).toEqual({
      form: null,
      fields: {
        name: "Your display name is public, so it can't contain your password.",
      },
    });
  });

  it("explains network, CSRF, busy and server errors", () => {
    expect(authFailure("login", new ApiError(0, "x")).form).toBe(
      "Can't reach NatureX. Check your connection and try again.",
    );
    const csrf = apiErrorFromResponse(new Response(null, { status: 403 }), {
      detail: "csrf_origin",
    });
    expect(authFailure("login", csrf).form).toMatch(/usual address/);
    expect(
      authFailure("login", new ApiError(503, "x", "auth_busy", "auth_busy", 1))
        .form,
    ).toBe("NatureX is busy right now. Try again in a second.");
    expect(authFailure("register", new ApiError(500, "x")).form).toBe(
      "Something went wrong on our side. Try again.",
    );
  });
});

describe("initials", () => {
  it.each([
    ["Rosa Díaz", "RD"],
    ["rosa", "R"],
    ["Ana María López", "AL"],
    ["  ", ""],
  ])("%s → %s", (name, expected) => expect(initials(name)).toBe(expected));
});
