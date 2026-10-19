import { describe, expect, it } from "vitest";

import type { MeOut, MyCommunity } from "@/lib/api/types";
import {
  appAccess,
  isActive,
  pickCommunity,
  switchTargets,
  withCommunity,
} from "@/lib/navigation";

const person: MeOut = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Rosa",
  email: "rosa@example.org",
  kind: "person",
  is_admin: false,
  world_id: "11111111-1111-4111-8111-111111111111",
};
const admin: MeOut = { ...person, is_admin: true };

function community(id: string, role: MyCommunity["role"]): MyCommunity {
  return {
    id,
    name: `Community ${id}`,
    country: null,
    description: null,
    created_at: "2026-10-18T00:00:00Z",
    role,
  };
}

describe("appAccess", () => {
  it.each([
    ["anonymous", null, undefined, false, ["exchange"], false],
    [
      "anonymous in the scripted demo",
      null,
      undefined,
      true,
      ["exchange", "steward"],
      false,
    ],
    ["investor", person, [], false, ["exchange"], true],
    [
      "steward",
      person,
      [community("a", "steward")],
      false,
      ["exchange", "steward"],
      false,
    ],
    [
      "owner",
      person,
      [community("a", "owner")],
      false,
      ["exchange", "steward"],
      false,
    ],
    ["admin", admin, [], false, ["exchange", "admin"], true],
    [
      "admin and owner",
      admin,
      [community("a", "owner")],
      false,
      ["exchange", "steward", "admin"],
      false,
    ],
  ] as const)(
    "%s",
    (_who, me, communities, prototypeDemo, apps, canCreateCommunity) => {
      expect(appAccess({ me, communities, prototypeDemo })).toEqual({
        apps,
        canCreateCommunity,
      });
    },
  );

  it("offers nothing that depends on communities until they load", () => {
    expect(appAccess({ me: person, communities: undefined })).toEqual({
      apps: ["exchange"],
      canCreateCommunity: false,
    });
    expect(appAccess({ me: admin, communities: undefined })).toEqual({
      apps: ["exchange", "admin"],
      canCreateCommunity: false,
    });
  });

  it("still offers the Steward app when the communities can't be read", () => {
    expect(
      appAccess({
        me: person,
        communities: undefined,
        communitiesFailed: true,
      }),
    ).toEqual({ apps: ["exchange", "steward"], canCreateCommunity: false });
    // Known communities win over a failed refetch.
    expect(
      appAccess({ me: person, communities: [], communitiesFailed: true }),
    ).toEqual({ apps: ["exchange"], canCreateCommunity: true });
  });

  it("ignores the scripted demo once signed in", () => {
    expect(
      appAccess({ me: person, communities: [], prototypeDemo: true }).apps,
    ).toEqual(["exchange"]);
  });
});

describe("switchTargets", () => {
  const all = { apps: ["exchange", "steward", "admin"] as const };
  it("offers the other apps", () => {
    const access = { apps: [...all.apps], canCreateCommunity: false };
    expect(switchTargets("exchange", access)).toEqual(["steward", "admin"]);
    expect(switchTargets("steward", access)).toEqual(["exchange", "admin"]);
    expect(switchTargets("admin", access)).toEqual(["exchange", "steward"]);
  });

  it("offers the Exchange from an app the visitor can't open", () => {
    const access = { apps: ["exchange" as const], canCreateCommunity: true };
    expect(switchTargets("steward", access)).toEqual(["exchange"]);
    expect(switchTargets("exchange", access)).toEqual([]);
  });
});

describe("pickCommunity", () => {
  const list = [community("a", "owner"), community("b", "steward")];
  it("takes the first preferred community the account still belongs to", () => {
    expect(pickCommunity(list, ["b", "a"])?.id).toBe("b");
    expect(pickCommunity(list, [null, "b"])?.id).toBe("b");
    expect(pickCommunity(list, ["gone", "b"])?.id).toBe("b");
  });
  it("falls back to the first otherwise", () => {
    expect(pickCommunity(list, ["gone", "tampered"])?.id).toBe("a");
    expect(pickCommunity(list, [null, undefined])?.id).toBe("a");
    expect(pickCommunity([], ["a"])).toBeNull();
  });
});

describe("withCommunity", () => {
  it("keeps the shown community in Steward links", () => {
    expect(withCommunity("/steward/list", "c1")).toBe(
      "/steward/list?community=c1",
    );
    expect(withCommunity("/steward?tab=x", "c1")).toBe(
      "/steward?tab=x&community=c1",
    );
    expect(withCommunity("/steward", null)).toBe("/steward");
  });
});

describe("isActive", () => {
  it("matches an app home exactly and other items by segment", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/portfolio", "/")).toBe(false);
    expect(isActive("/steward/list", "/steward")).toBe(false);
    expect(isActive("/steward/list", "/steward/list")).toBe(true);
    expect(isActive("/steward/list/new", "/steward/list")).toBe(true);
    expect(isActive("/portfolios", "/portfolio")).toBe(false);
  });
});
