import { screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ReportTab } from "@/components/proto/report-panels";
import type { AssetDetail, ReportOut } from "@/lib/api/types";
import { reportFacts, type ReportFacts } from "@/lib/report-facts";

import { json } from "../lib/helpers";
import asset from "./fixtures/asset.json";
import { renderExchange, stubBrowserApis } from "./render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/asset/x",
  useSearchParams: () => new URLSearchParams(),
}));

const V1 = (asset as unknown as AssetDetail).latest_report!;
const V2: ReportOut = {
  ...V1,
  id: "55555555-5555-4555-8555-555555555555",
  version: 2,
  health_score: "87.10",
  grade: "AA",
};
const VERSIONS = [V2, V1].map((r) => reportFacts(r)) as ReportFacts[];
const DIFF = `GET /reports/${V2.id}/diff/${V1.id}`;

beforeAll(stubBrowserApis);

describe("ReportTab reasons (T37)", () => {
  it("shows a loading line while the diff loads", async () => {
    renderExchange(<ReportTab versions={VERSIONS} showReasons />, {
      [DIFF]: () => new Promise<Response>(() => {}),
    });
    expect(
      await screen.findByText("Loading why it changed…"),
    ).toBeInTheDocument();
  });

  it("says so when the diff can't load", async () => {
    renderExchange(<ReportTab versions={VERSIONS} showReasons />, {
      [DIFF]: () => json({ detail: "boom" }, { status: 500 }),
    });
    expect(
      await screen.findByText("We couldn't load why it changed."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Why it changed")).not.toBeInTheDocument();
  });

  it("never calls the diff API without showReasons (the prototype)", async () => {
    const { backend } = renderExchange(<ReportTab versions={VERSIONS} />, {
      [DIFF]: () => json({}),
    });
    expect(
      await screen.findByText("What changed since v1"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading why it changed…")).toBeNull();
    expect(backend.calls(DIFF)).toBe(0);
  });
});
