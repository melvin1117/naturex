import { beforeEach, describe, expect, it, vi } from "vitest";

import IpoPage from "@/app/sandbox/steward/assets/[id]/ipo/page";
import VerifyPage from "@/app/sandbox/steward/assets/[id]/verify/page";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (href: string) => redirect(href),
}));

const ASSET = "33333333-3333-4333-8333-333333333333";
const COMMUNITY = "66666666-6666-4666-8666-666666666666";

beforeEach(() => redirect.mockClear());

describe("old listing screens", () => {
  it("sends the opening offer page to the flow's Offer step", async () => {
    await IpoPage({
      params: Promise.resolve({ id: ASSET }),
      searchParams: Promise.resolve({ community: COMMUNITY }),
    });
    expect(redirect).toHaveBeenCalledWith(
      `/sandbox/steward/list?community=${COMMUNITY}&asset=${ASSET}&step=offer`,
    );
  });

  it("sends the verification page to the flow's Prove step", async () => {
    await VerifyPage({
      params: Promise.resolve({ id: ASSET }),
      searchParams: Promise.resolve({}),
    });
    expect(redirect).toHaveBeenCalledWith(
      `/sandbox/steward/list?asset=${ASSET}&step=prove`,
    );
  });
});
