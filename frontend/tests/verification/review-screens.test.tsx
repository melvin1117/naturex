import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ListingReviewScreen } from "@/components/verification/listing-review-screen";
import { ReviewQueueScreen } from "@/components/verification/review-queue-screen";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";

import { stubBrowserApis } from "../exchange/render";
import {
  ADMIN_WORLD,
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
} from "../lib/helpers";
import { asset as assetFixture } from "../trade/fixtures";
import {
  ASSET_ID,
  DOC_MINUTES,
  queueItem,
  run,
  RUN_ID,
  verifiedRun,
  CHECKLIST,
  panel,
  verifiedPanel,
} from "./fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/admin/verifications",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  stubBrowserApis();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
beforeEach(() => FakeEventSource.reset());

const QUEUE = "GET /admin/verifications";
const ASSET = `GET /assets/${ASSET_ID}`;
const RUNS = `GET /assets/${ASSET_ID}/verification/runs`;
const PREVIEW = `GET /assets/${ASSET_ID}/documents/${DOC_MINUTES}/preview`;
const PANEL = `GET /assets/${ASSET_ID}/verification`;
const decisionRoute = (d: string) =>
  `POST /admin/assets/${ASSET_ID}/verification/${RUN_ID}/${d}`;

const POLYGON = {
  type: "Polygon",
  coordinates: [
    [
      [-99.1, 19.2],
      [-99.0, 19.2],
      [-99.0, 19.3],
      [-99.1, 19.2],
    ],
  ],
};

function renderAdmin(
  ui: React.ReactNode,
  routes: Parameters<typeof fakeBackend>[0],
) {
  const backend = fakeBackend({
    "GET /world": () => json(ADMIN_WORLD),
    "GET /assets/outlines": () => json({ outlines: [], truncated: false }),
    [QUEUE]: () => json([queueItem()]),
    [PANEL]: () => json(panel({ level: "documents_submitted" })),
    [ASSET]: () =>
      json(assetFixture({ name: "Río Claro Forest", geojson: POLYGON })),
    [PREVIEW]: () =>
      new Response("png bytes", { headers: { "Content-Type": "image/png" } }),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(<WorldProvider dataLayer={layer}>{ui}</WorldProvider>);
  return backend;
}

describe("ReviewQueueScreen", () => {
  it("lists listings waiting for review with their check results", async () => {
    const failing = queueItem({
      asset_id: "44444444-0000-4000-8000-000000000000",
      asset_name: "Selva Norte",
      run: run({
        checklist: [
          ...CHECKLIST.slice(0, 3),
          { ...CHECKLIST[3]!, result: "fail" },
        ],
      }),
    });
    const backend = renderAdmin(<ReviewQueueScreen />, {
      [QUEUE]: () => json([queueItem(), failing]),
    });
    const list = await screen.findByRole("list", {
      name: "Listings waiting for review",
    });
    expect(
      within(list).getByRole("heading", { level: 2, name: "Río Claro Forest" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("heading", { level: 2, name: "Selva Norte" }),
    ).toBeInTheDocument();
    expect(within(list).getAllByText("Real documents")).toHaveLength(2);
    expect(within(list).getByText("Failed")).toBeInTheDocument();
    expect(
      within(list).getByRole("link", { name: "Review Río Claro Forest" }),
    ).toHaveAttribute("href", `/admin/verifications/${ASSET_ID}`);
    const query = new URL(
      backend.requests.find((r) => r.url.includes("/admin/verifications"))!.url,
    ).searchParams;
    expect(Object.fromEntries(query)).toEqual({ limit: "20", offset: "0" });
  });

  it("pages through the queue, Next and Previous", async () => {
    const page = Array.from({ length: 20 }, (_, i) =>
      queueItem({
        asset_id: `44444444-0000-4000-8000-${String(i).padStart(12, "0")}`,
        asset_name: `Site ${i + 1}`,
      }),
    );
    const backend = renderAdmin(<ReviewQueueScreen />, {
      [QUEUE]: (request) =>
        json(
          new URL(request.url).searchParams.get("offset") === "0" ? page : [],
        ),
    });
    expect(
      await screen.findByRole("heading", { name: "Site 20" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText("No more listings on this page."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(
      await screen.findByRole("heading", { name: "Site 1" }),
    ).toBeInTheDocument();
    const offsets = backend.requests
      .filter((r) => r.url.includes("/admin/verifications"))
      .map((r) => new URL(r.url).searchParams.get("offset"));
    expect(offsets).toEqual(["0", "20", "0"]);
  });

  it("says when nothing is waiting", async () => {
    renderAdmin(<ReviewQueueScreen />, { [QUEUE]: () => json([]) });
    expect(
      await screen.findByText("Nothing is waiting for review."),
    ).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    renderAdmin(<ReviewQueueScreen />, {
      [QUEUE]: sequence(
        () => json({ detail: "admin_only" }, { status: 403 }),
        () => json([]),
      ),
    });
    expect(
      await screen.findByText("Only a platform admin can do that."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Nothing is waiting for review."),
    ).toBeInTheDocument();
  });
});

describe("ListingReviewScreen", () => {
  it("shows previews, the checklist, the AI suggestion and the map", async () => {
    renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () => json([run()]),
    });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Río Claro Forest",
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("img", {
        name: "Preview of the assembly minutes (consent)",
      }),
    ).toHaveAttribute("src", "blob:preview");
    expect(
      screen.getByText(
        "No preview: this PDF's first page holds no scanned image.",
      ),
    ).toBeInTheDocument();
    const downloads = screen.getAllByRole("link", {
      name: /Download the original/,
    });
    expect(downloads[0]).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/api\/assets\/.+\/documents\/.+$/),
    );
    expect(screen.getByText("no overlap")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 2, name: "AI suggestion" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Untrusted heuristic")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Río Claro Forest map" }),
    ).toBeInTheDocument();
  });

  it("offers the original only as a download, and explains a preview that failed", async () => {
    renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () => json([run()]),
      [PREVIEW]: () => json({ detail: "boom" }, { status: 500 }),
    });
    expect(
      await screen.findByText(/The preview didn't load/),
    ).toBeInTheDocument();
    // The title is a text PDF: no preview is asked for.
    expect(
      screen.getByText(
        "No preview: this PDF's first page holds no scanned image.",
      ),
    ).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", {
      name: /Download the original/,
    }))
      expect(link).toHaveAttribute("download");
  });

  it("shows the Exchange's badge: a revocation stands through a new submission", async () => {
    renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () =>
        json([
          run(),
          run({
            id: "99999999-9999-4999-8999-999999999999",
            is_current: false,
            level: "revoked",
            effective_level: "revoked",
          }),
        ]),
      [PANEL]: () =>
        json(panel({ level: "revoked", badge: "Verification revoked" })),
    });
    const badge = await screen.findByText("Verification revoked");
    expect(badge.closest("[data-level]")).toHaveAttribute(
      "data-level",
      "revoked",
    );
    // The new submission is still reviewed.
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("reloads the run when another decision got there first", async () => {
    const backend = renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: sequence(
        () => json([run()]),
        () => json([verifiedRun()]),
      ),
      [PANEL]: sequence(
        () => json(panel({ level: "documents_submitted" })),
        () => json(verifiedPanel()),
      ),
      [decisionRoute("approve")]: () =>
        json({ detail: "run_already_decided" }, { status: 409 }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already been decided/,
    );
    expect(
      await screen.findByRole("button", { name: "Revoke verification" }),
    ).toBeInTheDocument();
    expect(backend.calls(RUNS)).toBe(2);
    expect(screen.queryByText("Decision recorded")).not.toBeInTheDocument();
  });

  it("approves with an optional note", async () => {
    const backend = renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: sequence(
        () => json([run()]),
        () => json([verifiedRun()]),
      ),
      [decisionRoute("approve")]: () => json(verifiedRun()),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Decision recorded")).toBeInTheDocument();
    const post = backend.requests.find((r) => r.method === "POST")!;
    expect(await post.json()).toEqual({ reason: null });
    // Now verified: the form offers a revocation instead.
    expect(
      await screen.findByRole("button", { name: "Revoke verification" }),
    ).toBeInTheDocument();
  });

  it("won't reject without a reason, then sends it", async () => {
    const backend = renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () => json([run()]),
      [decisionRoute("reject")]: () =>
        json(run({ level: "rejected", effective_level: "rejected" })),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/Write a reason/)).toBeInTheDocument();
    expect(backend.calls(decisionRoute("reject"))).toBe(0);
    // Focus goes to the reason, which now describes the error.
    const reason = screen.getByLabelText("Reason or note for the steward");
    expect(reason).toHaveFocus();
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription(/Write a reason/);

    fireEvent.change(screen.getByLabelText("Reason or note for the steward"), {
      target: { value: "  The minutes are unsigned.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await screen.findByText("Decision recorded");
    const post = backend.requests.find((r) => r.method === "POST")!;
    expect(await post.json()).toEqual({ reason: "The minutes are unsigned." });
  });

  it("keeps the clicked button focusable while a decision is sent", async () => {
    let finish: (r: Response) => void = () => {};
    const backend = renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () => json([run()]),
      [decisionRoute("approve")]: () =>
        new Promise<Response>((resolve) => (finish = resolve)),
    });
    const approve = await screen.findByRole("button", { name: "Approve" });
    approve.focus();
    fireEvent.click(approve);
    await waitFor(() =>
      expect(approve).toHaveAttribute("aria-disabled", "true"),
    );
    expect(approve).toBeEnabled();
    expect(approve).toHaveFocus();
    fireEvent.click(approve);
    expect(backend.calls(decisionRoute("approve"))).toBe(1);
    await act(async () => finish(json(verifiedRun())));
    expect(await screen.findByText("Decision recorded")).toBeInTheDocument();
  });

  it("can't approve a run with a failed check", async () => {
    renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () =>
        json([
          run({
            checklist: [
              ...CHECKLIST.slice(0, 3),
              { ...CHECKLIST[3]!, result: "fail" },
            ],
          }),
        ]),
    });
    expect(
      await screen.findByRole("button", { name: "Approve" }),
    ).toBeDisabled();
    expect(
      screen.getByText("1 check failed, so this run can't be approved."),
    ).toBeInTheDocument();
  });

  it("explains a refused decision", async () => {
    renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () => json([run()]),
      [decisionRoute("approve")]: () =>
        json({ detail: "stale_run" }, { status: 409 }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /The steward needs to submit again/,
    );
  });

  it("revokes a verified run after a reason and a confirmation", async () => {
    const backend = renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () => json([verifiedRun()]),
      [decisionRoute("revoke")]: () =>
        json(
          verifiedRun({
            level: "revoked",
            effective_level: "revoked",
            revoke_reason: "A boundary dispute.",
          }),
        ),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke verification" }),
    );
    expect(await screen.findByText(/Write a reason/)).toBeInTheDocument();
    fireEvent.change(
      screen.getByLabelText("Reason for revoking (the steward sees it)"),
      { target: { value: "A boundary dispute." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke verification" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/trading is suspended/),
    ).toBeInTheDocument();
    expect(backend.calls(decisionRoute("revoke"))).toBe(0);
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Revoke and suspend trading",
      }),
    );
    await waitFor(() => expect(backend.calls(decisionRoute("revoke"))).toBe(1));
    const post = backend.requests.find((r) => r.method === "POST")!;
    expect(await post.json()).toEqual({ reason: "A boundary dispute." });
  });

  it("sends nothing when the revocation is cancelled", async () => {
    const backend = renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () => json([verifiedRun()]),
    });
    fireEvent.change(
      await screen.findByLabelText("Reason for revoking (the steward sees it)"),
      { target: { value: "A boundary dispute." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke verification" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep it verified" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(backend.calls(decisionRoute("revoke"))).toBe(0);
    expect(
      screen.getByRole("button", { name: "Revoke verification" }),
    ).toHaveFocus();
    expect(backend.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("explains a listing it can't find", async () => {
    renderAdmin(<ListingReviewScreen assetId={ASSET_ID} />, {
      [RUNS]: () => json({ detail: "not_found" }, { status: 404 }),
    });
    expect(
      await screen.findByText("We couldn't find this listing"),
    ).toBeInTheDocument();
  });
});
