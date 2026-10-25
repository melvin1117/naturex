import { describe, expect, it } from "vitest";

import type { MyCommunity } from "@/lib/api/types";
import { pickCommunity, withCommunity } from "@/lib/navigation";

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
