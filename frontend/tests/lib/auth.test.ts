import { describe, expect, it } from "vitest";
import {
  initials,
  loginHref,
  protectedAccess,
  safeReturnPath,
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

describe("initials", () => {
  it.each([
    ["Rosa Díaz", "RD"],
    ["rosa", "R"],
    ["Ana María López", "AL"],
    ["  ", ""],
  ])("%s → %s", (name, expected) => expect(initials(name)).toBe(expected));
});
