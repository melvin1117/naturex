import { fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ReportTab } from "@/components/proto/report-panels";
import type { AssetDetail, ReportDiff, ReportOut } from "@/lib/api/types";
import { reportFacts, type ReportFacts } from "@/lib/report-facts";

import { json, sequence } from "../lib/helpers";
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

const BODY: ReportDiff = {
  report_id: V2.id,
  prev_report_id: V1.id,
  changes: [],
  from_version: 1,
  to_version: 2,
  grade_change: { old: "A", new: "AA", direction: "up" },
  metrics: [
    {
      id: "score:health",
      label: "Health score",
      group: "headline",
      unit: "/100",
      change: "changed",
      old: "76.20",
      new: "87.10",
      delta: "10.90",
      reason_refs: [0, 7],
    },
    {
      id: "valuation:value_mid",
      label: "Value (mid)",
      group: "headline",
      unit: "Int$/yr",
      change: "changed",
      old: "2400000",
      new: "2250000",
      delta: "-150000",
      reason_refs: [1],
    },
    {
      id: "score:threat_pressure",
      label: "Threat pressure (1 = none)",
      group: "health",
      unit: "0-1",
      change: "changed",
      old: "0.9",
      new: "0.75",
      delta: "-0.15",
      reason_refs: [1],
    },
    {
      id: "metric:landcover.built",
      label: "Land cover: built",
      group: "satellite",
      unit: "share",
      change: "added",
      old: null,
      new: "0.034",
      delta: null,
      reason_refs: [],
    },
  ],
  reasons: [
    {
      source: "auditor",
      version: 2,
      code: "key_change",
      text: "Replanting raised vegetation vigour.",
      citations: ["score:health"],
    },
    {
      source: "event",
      version: 2,
      code: "event_new",
      text: "New road cut through the forest edge.",
      citations: ["score:threat_pressure"],
    },
  ],
};

const live = (body: Partial<ReportDiff> = {}) =>
  renderExchange(<ReportTab versions={VERSIONS} live />, {
    [DIFF]: () => json({ ...BODY, ...body }),
  });

function rowOf(label: string) {
  return screen.getByText(label).closest("tr")!;
}

beforeAll(stubBrowserApis);

describe("ReportTab changes from the diff API (#189)", () => {
  it("renders the headline rows from diff.metrics, the grade change first", async () => {
    live();
    const table = await screen.findByRole("table", {
      name: "Numbers that changed from v1 to v2",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Metricv1v2",
      "GradeAAAUpgraded",
      expect.stringMatching(/^Health score.*76\.287\.1\+10\.9$/),
      expect.stringMatching(/^Value \(mid\).*\$2\.4M\$2\.3M−\$150K$/),
    ]);
    // The browser-side comparison is gone on the real path.
    expect(screen.queryByText("Fair price per unit")).toBeNull();
    expect(screen.queryByText("Threat pressure (1 = none)")).toBeNull();
  });

  it("shows the other groups on request, each under its own heading", async () => {
    live();
    const toggle = await screen.findByRole("button", {
      name: "Show 2 more changed numbers",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Show headline changes only");
    expect(
      screen.getByRole("columnheader", { name: "How the score is built" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Satellite data" }),
    ).toBeInTheDocument();
    expect(rowOf("Threat pressure (1 = none)")).toHaveTextContent(
      /90 \/ 10075 \/ 100−15 pts$/,
    );
    expect(rowOf("Land cover: built")).toHaveTextContent(/—3\.4%New$/);
  });

  it("opens every group when no headline number or grade changed", async () => {
    live({
      grade_change: null,
      metrics: BODY.metrics.filter((m) => m.group !== "headline"),
    });
    expect(
      await screen.findByRole("columnheader", {
        name: "How the score is built",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /changed number/ })).toBeNull();
  });

  it("links each row to the reasons that cite it", async () => {
    live();
    const link = await screen.findByRole("link", {
      name: "Reason 1: why Health score changed",
    });
    // A ref past the end of the reasons is ignored.
    expect(within(rowOf("Health score")).getAllByRole("link")).toHaveLength(1);
    const reason = screen
      .getByText("Replanting raised vegetation vigour.")
      .closest("li")!;
    expect(link).toHaveAttribute("href", `#${reason.id}`);
    expect(reason).toHaveTextContent(/^Reason 1\s*Auditor/);

    fireEvent.click(link);
    expect(reason).toHaveFocus();
    expect(reason.className).toMatch(/ring-lime/);

    fireEvent.click(
      screen.getByRole("link", { name: "Reason 2: why Value (mid) changed" }),
    );
    const second = screen
      .getByText("New road cut through the forest edge.")
      .closest("li")!;
    expect(second).toHaveFocus();
    expect(second).toHaveTextContent(/^Reason 2\s*News/);
    expect(reason.className).not.toMatch(/ring-lime/);
  });

  it("says when no number changed", async () => {
    live({ grade_change: null, metrics: [], reasons: [] });
    expect(
      await screen.findByText("No numbers changed between v1 and v2."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByText("No reasons were recorded between these versions."),
    ).toBeInTheDocument();
  });

  it("shows a loading state while the diff loads", async () => {
    renderExchange(<ReportTab versions={VERSIONS} live />, {
      [DIFF]: () => new Promise<Response>(() => {}),
    });
    const loading = await screen.findByText("Loading what changed…");
    expect(loading.closest("[role=status]")).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so when the diff can't load, and retries", async () => {
    const { backend } = renderExchange(<ReportTab versions={VERSIONS} live />, {
      [DIFF]: sequence(
        () => json({ detail: "boom" }, { status: 500 }),
        () => json(BODY),
      ),
    });
    expect(
      await screen.findByText("We couldn't load what changed"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Why it changed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Why it changed")).toBeInTheDocument();
    expect(backend.calls(DIFF)).toBe(2);
  });

  it("keeps the prototype's own comparison and never calls the diff API", async () => {
    const { backend } = renderExchange(<ReportTab versions={VERSIONS} />, {
      [DIFF]: () => json(BODY),
    });
    expect(
      await screen.findByText("What changed since v1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Fair price per unit")).toBeInTheDocument();
    expect(screen.queryByText("Loading what changed…")).toBeNull();
    expect(screen.queryByText("Why it changed")).toBeNull();
    expect(backend.calls(DIFF)).toBe(0);
  });
});
