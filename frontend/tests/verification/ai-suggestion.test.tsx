import { act, render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AiUploadNotice } from "@/components/verification/ai-upload-notice";
import { ListingReviewScreen } from "@/components/verification/listing-review-screen";
import { StewardVerifyScreen } from "@/components/verification/steward-verify-screen";
import { WorldProvider } from "@/components/world-provider";
import { AI_POLL_MS } from "@/lib/ai-suggestion";
import type { DocumentAiCheck } from "@/lib/api/types";
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
  SIGNED_IN_WORLD,
} from "../lib/helpers";
import { asset as assetFixture } from "../trade/fixtures";
import {
  AI_NOTICE,
  aiReading,
  aiSuggestion,
  ASSET_ID,
  DOC_MINUTES,
  DOC_TITLE,
  panel,
  queueItem,
  run,
  RUN_ID,
  verifiedRun,
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
afterEach(() => vi.useRealTimers());

const QUEUE = "GET /admin/verifications";
const RUNS = `GET /assets/${ASSET_ID}/verification/runs`;
const APPROVE = `POST /admin/assets/${ASSET_ID}/verification/${RUN_ID}/approve`;

type Routes = Parameters<typeof fakeBackend>[0];

function renderReview(routes: Routes) {
  const backend = fakeBackend({
    "GET /world": () => json(ADMIN_WORLD),
    "GET /assets/outlines": () => json({ outlines: [], truncated: false }),
    [`GET /assets/${ASSET_ID}`]: () =>
      json(assetFixture({ name: "Río Claro Forest" })),
    [`GET /assets/${ASSET_ID}/verification`]: () =>
      json(panel({ level: "documents_submitted" })),
    [`GET /assets/${ASSET_ID}/documents/${DOC_MINUTES}/preview`]: () =>
      new Response("png", { headers: { "Content-Type": "image/png" } }),
    [RUNS]: () => json([run()]),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <ListingReviewScreen assetId={ASSET_ID} />
    </WorldProvider>,
  );
  return backend;
}

async function aiPanel(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", {
    level: 2,
    name: "AI suggestion",
  });
  return heading.closest("section")!;
}

describe("AI suggestion on the review page", () => {
  it("asks the queue for this listing only, and labels the suggestion untrusted", async () => {
    const backend = renderReview({
      [QUEUE]: () =>
        json([
          queueItem({
            ai_suggestion_status: "completed",
            ai_suggestion: aiSuggestion(),
          }),
        ]),
    });
    const section = await aiPanel();
    expect(
      await within(section).findByText("Consistent with the listing"),
    ).toBeInTheDocument();
    expect(within(section).getByText("Untrusted heuristic")).toBeVisible();
    expect(within(section).getByText(AI_NOTICE)).toBeInTheDocument();
    expect(
      within(section).getByText(
        "The AI suggests (not a check result, not a decision)",
      ),
    ).toBeInTheDocument();
    const query = new URL(
      backend.requests.find((r) => r.url.includes("/admin/verifications"))!.url,
    ).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      asset_id: ASSET_ID,
      limit: "1",
    });
  });

  it("shows reasons, each comparison, each document read, flags and provenance", async () => {
    renderReview({
      [QUEUE]: () =>
        json([
          queueItem({
            ai_suggestion_status: "completed",
            ai_suggestion: aiSuggestion({
              suggestion: "inconsistent",
              reasons: ["Document 1, place: a different municipality."],
              comparisons: [
                {
                  document_id: DOC_TITLE,
                  field: "place",
                  listing_value: "Ejemplo, Estado de Prueba",
                  document_value: "Otro Lugar",
                  excerpt: "municipio de Otro Lugar",
                  verdict: "mismatch",
                  reason: "A different municipality.",
                  compared_by: "model",
                },
                {
                  document_id: DOC_TITLE,
                  field: "area",
                  listing_value: "144.00 ha",
                  document_value: "1,440",
                  excerpt: "Superficie 1,440",
                  verdict: "unclear",
                  reason: "The excerpt prints no unit.",
                  compared_by: "code",
                },
              ],
              documents: [
                aiReading({ instruction_like_text: true, area_ha: "1440.50" }),
                aiReading({
                  document_id: DOC_MINUTES,
                  doc_type: "assembly_minutes",
                  sent_to_model: false,
                  not_sent_reason: "not_sample",
                  readable: false,
                }),
              ],
              flags: [
                "instruction_like_text",
                "documents_not_sent",
                "reason_withheld",
                "mock_model",
                "brand_new_flag",
              ],
            }),
          }),
        ]),
    });
    const section = await aiPanel();
    expect(
      await within(section).findByText("Inconsistent with the listing"),
    ).toBeInTheDocument();
    expect(
      within(section).getByText("Document 1, place: a different municipality."),
    ).toBeInTheDocument();

    const comparisons = within(section).getByRole("list", {
      name: "Field comparisons",
    });
    const [place, area] = within(comparisons).getAllByRole("listitem");
    expect(place).toHaveTextContent("Place · Document 1 · Land title");
    expect(within(place!).getByText("Doesn't match")).toBeInTheDocument();
    expect(
      within(place!).getByText("Ejemplo, Estado de Prueba"),
    ).toBeInTheDocument();
    expect(within(place!).getByText("Otro Lugar")).toBeInTheDocument();
    expect(
      within(place!).getByText("municipio de Otro Lugar"),
    ).toBeInTheDocument();
    expect(
      within(place!).getByText("Compared by the AI model"),
    ).toBeInTheDocument();
    expect(within(area!).getByText("Unclear")).toBeInTheDocument();
    expect(within(area!).getByText("Compared by code")).toBeInTheDocument();

    const read = within(section).getByRole("list", { name: "Documents read" });
    const [title, minutes] = within(read).getAllByRole("listitem");
    expect(
      within(title!).getByText(
        "Sent to the model as a preview image; it could read it.",
      ),
    ).toBeInTheDocument();
    expect(
      within(title!).getByText(/Holds text aimed at an AI model/),
    ).toBeInTheDocument();
    expect(within(title!).getByText("RAN-0042")).toBeInTheDocument();
    expect(
      within(title!).getByText("(= 1,440.5 ha, converted by code)", {
        exact: false,
      }).textContent,
    ).toContain("1,440.5\u00a0ha");
    expect(minutes).toHaveTextContent(
      "Document 2 · Assembly minutes (consent)",
    );
    expect(
      within(minutes!).getByText(
        "Not sent to the model: a demo world sends only sample documents.",
      ),
    ).toBeInTheDocument();

    const warnings = within(section).getByRole("list", { name: "Warnings" });
    expect(warnings).toHaveTextContent(/sign of manipulation/);
    expect(warnings).toHaveTextContent(/each document below says why/);
    expect(warnings).toHaveTextContent(/that verdict counts as unclear/);
    expect(warnings).toHaveTextContent(/not a real AI model/);
    expect(warnings).toHaveTextContent("Flag: brand new flag");

    expect(
      within(section).getByText(
        "openbmb/MiniCPM-V-4_5, nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
      ),
    ).toBeInTheDocument();
    expect(within(section).getByText("naturex-doc-check-v1")).toBeVisible();
    expect(within(section).getByText("18 Oct 2026, 11:04 UTC")).toBeVisible();
  });

  it("renders hostile document text literally: no HTML, Markdown or links", async () => {
    const hostile = {
      html: '<img src=x onerror="alert(1)">',
      bold: "**bold** _em_ `code`",
      link: "[link](https://evil.example)",
      bare: "https://evil.example/phish",
      script: "<script>alert(2)</script>",
    };
    renderReview({
      [QUEUE]: () =>
        json([
          queueItem({
            ai_suggestion_status: "completed",
            ai_suggestion: aiSuggestion({
              suggestion: "inconsistent",
              reasons: [hostile.bold, hostile.link],
              comparisons: [
                {
                  document_id: DOC_TITLE,
                  field: "holder_name",
                  listing_value: hostile.script,
                  document_value: hostile.html,
                  excerpt: hostile.link,
                  verdict: "mismatch",
                  reason: hostile.bare,
                  compared_by: "model",
                },
              ],
              documents: [
                aiReading({
                  holder_name: { value: hostile.html, excerpt: hostile.bold },
                  place: { value: "x".repeat(2000), excerpt: null },
                }),
              ],
            }),
          }),
        ]),
    });
    const section = await aiPanel();
    await within(section).findByText("Inconsistent with the listing");

    expect(section.querySelector("img, script, a, strong, em, code")).toBe(
      null,
    );
    expect(within(section).getAllByText(hostile.html)).toHaveLength(2);
    expect(within(section).getAllByText(hostile.bold)).toHaveLength(2);
    expect(within(section).getAllByText(hostile.link)).toHaveLength(2);
    expect(within(section).getByText(hostile.bare)).toBeInTheDocument();
    expect(within(section).getByText(hostile.script)).toBeInTheDocument();
    for (const node of section.querySelectorAll("[data-untrusted]"))
      expect(node.tagName).toBe("BDI");
    const long = within(section).getByText(/^x+…$/);
    expect(long.textContent).toHaveLength(600);
  });

  it("keeps bidi overrides and zero-width characters literal, inside <bdi>", async () => {
    const spoof = "\u202Eexe.fdp\u202C Ejido";
    const hidden = "Eji\u200Bdo\u200D Río\uFEFFClaro";
    const unbroken = "\u200B".repeat(40) + "A".repeat(300);
    renderReview({
      [QUEUE]: () =>
        json([
          queueItem({
            ai_suggestion_status: "completed",
            ai_suggestion: aiSuggestion({
              reasons: [spoof],
              comparisons: [
                {
                  document_id: DOC_TITLE,
                  field: "holder_name",
                  listing_value: "Río Claro Keepers",
                  document_value: hidden,
                  excerpt: unbroken,
                  verdict: "unclear",
                  reason: spoof,
                  compared_by: "model",
                },
              ],
            }),
          }),
        ]),
    });
    const section = await aiPanel();
    await within(section).findByText("Consistent with the listing");
    const untrusted = Array.from(
      section.querySelectorAll<HTMLElement>("[data-untrusted]"),
    );
    for (const text of [spoof, hidden, unbroken]) {
      const node = untrusted.find((n) => n.textContent === text);
      expect(node, JSON.stringify(text)).toBeDefined();
      expect(node!.tagName).toBe("BDI");
      expect(node!.className).toContain("[overflow-wrap:anywhere]");
      expect(node!.children).toHaveLength(0);
    }
    expect(untrusted.filter((n) => n.textContent === spoof)).toHaveLength(2);
  });

  it("says the check is running, politely, and updates by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = renderReview({
      [QUEUE]: sequence(
        () => json([queueItem({ ai_suggestion_status: "pending" })]),
        () =>
          json([
            queueItem({
              ai_suggestion_status: "completed",
              ai_suggestion: aiSuggestion(),
            }),
          ]),
      ),
    });
    const section = await aiPanel();
    const status = within(section).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    await waitFor(() =>
      expect(status).toHaveTextContent(
        "The AI check is still reading the documents.",
      ),
    );
    expect(within(section).getAllByRole("status")).toHaveLength(1);
    expect(backend.calls(QUEUE)).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(AI_POLL_MS));

    expect(
      await within(section).findByText("Consistent with the listing"),
    ).toBeInTheDocument();
    expect(within(section).getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("AI suggestion ready.");
    expect(backend.calls(QUEUE)).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(AI_POLL_MS * 2));
    expect(backend.calls(QUEUE)).toBe(2);
  });

  it("announces a check that leaves pending without finishing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderReview({
      [QUEUE]: sequence(
        () => json([queueItem({ ai_suggestion_status: "pending" })]),
        () => json([queueItem({ ai_suggestion_status: "failed" })]),
      ),
    });
    const section = await aiPanel();
    const status = within(section).getByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent(/still reading the documents/),
    );

    await act(() => vi.advanceTimersByTimeAsync(AI_POLL_MS));

    expect(
      await within(section).findByText("The AI check didn't finish"),
    ).toBeInTheDocument();
    expect(status).toHaveTextContent("AI suggestion didn't finish.");
  });

  it("stops polling once the run is decided, though the cache still says pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = renderReview({
      [RUNS]: sequence(
        () => json([run()]),
        () => json([verifiedRun()]),
      ),
      [QUEUE]: () => json([queueItem({ ai_suggestion_status: "pending" })]),
      [APPROVE]: () => json(verifiedRun()),
    });
    const section = await aiPanel();
    await within(section).findByText(
      "The AI check is still reading the documents",
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Decision recorded")).toBeInTheDocument();
    expect(
      await within(section).findByText(/Shown while a submission waits/),
    ).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const settled = backend.calls(QUEUE);

    await act(() => vi.advanceTimersByTimeAsync(AI_POLL_MS * 3));

    expect(backend.calls(QUEUE)).toBe(settled);
  });

  it("doesn't poll from a hidden tab, and asks once when it's seen again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      const backend = renderReview({
        [QUEUE]: () => json([queueItem({ ai_suggestion_status: "pending" })]),
      });
      const section = await aiPanel();
      await within(section).findByText(
        "The AI check is still reading the documents",
      );
      await act(() => vi.advanceTimersByTimeAsync(AI_POLL_MS * 2));
      expect(backend.calls(QUEUE)).toBe(1);

      hidden.mockReturnValue(false);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(backend.calls(QUEUE)).toBe(2));
      await act(() => vi.advanceTimersByTimeAsync(AI_POLL_MS));
      expect(backend.calls(QUEUE)).toBe(3);
    } finally {
      hidden.mockRestore();
    }
  });

  it("says a newer submission is waiting when the queue holds another run", async () => {
    const backend = renderReview({
      [QUEUE]: () =>
        json([
          queueItem({
            run: run({ id: "99999999-9999-4999-8999-999999999999" }),
            ai_suggestion_status: "completed",
            ai_suggestion: aiSuggestion(),
          }),
        ]),
    });
    const section = await aiPanel();
    expect(
      await within(section).findByText(
        "A newer submission is waiting for review",
      ),
    ).toBeInTheDocument();
    expect(
      within(section).queryByText("Consistent with the listing"),
    ).not.toBeInTheDocument();
    expect(backend.calls(RUNS)).toBe(1);

    fireEvent.click(
      within(section).getByRole("button", { name: "Reload the submission" }),
    );

    await waitFor(() => expect(backend.calls(RUNS)).toBe(2));
  });

  it("explains a check that didn't run", async () => {
    renderReview({ [QUEUE]: () => json([queueItem()]) });
    const section = await aiPanel();
    expect(
      await within(section).findByText("Not run for this submission"),
    ).toBeInTheDocument();
    expect(within(section).getByText(/The AI check is off in this world/));
    expect(within(section).getByRole("status")).toBeEmptyDOMElement();
  });

  it("explains a check that failed, with the stored reason", async () => {
    renderReview({
      [QUEUE]: () =>
        json([
          queueItem({
            ai_suggestion_status: "failed",
            ai_suggestion: aiSuggestion({
              status: "failed",
              suggestion: null,
              reasons: [
                "No model answered (or the AI budget is spent); review the documents yourself.",
              ],
              comparisons: [],
              documents: [],
              flags: [],
              models: [],
            }),
          }),
        ]),
    });
    const section = await aiPanel();
    expect(
      await within(section).findByText("The AI check didn't finish"),
    ).toBeInTheDocument();
    expect(within(section).getByText(/No model answered \(or/)).toBeVisible();
    expect(
      within(section).queryByText(/The AI suggests/),
    ).not.toBeInTheDocument();
  });

  it("explains a failed load, with a retry", async () => {
    renderReview({
      [QUEUE]: sequence(
        () => json({ detail: "boom" }, { status: 500 }),
        () => json([queueItem()]),
      ),
    });
    const section = await aiPanel();
    expect(
      await within(section).findByText("We couldn't load the AI suggestion"),
    ).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Try again" }));
    expect(
      await within(section).findByText("Not run for this submission"),
    ).toBeInTheDocument();
  });

  it("says when the listing isn't in this admin's queue", async () => {
    renderReview({ [QUEUE]: () => json([]) });
    const section = await aiPanel();
    expect(
      await within(section).findByText(/Not available: the AI suggestion/),
    ).toBeInTheDocument();
  });

  it("isn't asked for once the run is decided", async () => {
    const backend = renderReview({
      [RUNS]: () => json([verifiedRun()]),
      [QUEUE]: () => json([queueItem()]),
    });
    const section = await aiPanel();
    expect(
      within(section).getByText(/Shown while a submission waits/),
    ).toBeInTheDocument();
    await screen.findByRole("button", { name: "Revoke verification" });
    expect(backend.calls(QUEUE)).toBe(0);
  });

  it("never changes the decision: an inconsistent suggestion can still be approved", async () => {
    const backend = renderReview({
      [RUNS]: sequence(
        () => json([run()]),
        () => json([verifiedRun()]),
      ),
      [QUEUE]: () =>
        json([
          queueItem({
            ai_suggestion_status: "completed",
            ai_suggestion: aiSuggestion({ suggestion: "inconsistent" }),
          }),
        ]),
      [APPROVE]: () => json(verifiedRun()),
    });
    const section = await aiPanel();
    await within(section).findByText("Inconsistent with the listing");
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(await screen.findByText("Decision recorded")).toBeInTheDocument();
    expect(backend.calls(APPROVE)).toBe(1);
  });
});

describe("Uploader notice (ADR-0006 §5)", () => {
  function renderSteward(mode: DocumentAiCheck) {
    const backend = fakeBackend({
      "GET /world": () => json({ ...SIGNED_IN_WORLD, document_ai_check: mode }),
      [`GET /assets/${ASSET_ID}`]: () =>
        json(assetFixture({ name: "Río Claro Forest" })),
      [RUNS]: () => json([]),
      [`GET /assets/${ASSET_ID}/documents`]: () => json([]),
      [`GET /assets/${ASSET_ID}/verification`]: () => json(panel()),
    });
    const layer = createDataLayer({
      baseUrl: BASE,
      fetch: backend.fetch,
      createEventSource: createFakeEventSource,
    });
    render(
      <WorldProvider dataLayer={layer}>
        <StewardVerifyScreen assetId={ASSET_ID} />
      </WorldProvider>,
    );
  }

  async function notice(): Promise<HTMLElement> {
    const upload = await screen.findByRole("heading", {
      name: "Upload a document",
    });
    const card = upload.closest("section, [aria-labelledby]") as HTMLElement;
    const note = within(card).getByRole("note");
    // Before the upload form: read first.
    const file = within(card).getByLabelText("File");
    expect(
      note.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    return note;
  }

  it("says an AI model on Nebius Token Factory may read the documents where it does", async () => {
    renderSteward("uploads");
    const note = await notice();
    await waitFor(() =>
      expect(note).toHaveTextContent("An AI model may read your documents"),
    );
    expect(note).toHaveTextContent(/AI model on Nebius Token Factory/);
    expect(note).toHaveTextContent(/never the original file/);
    expect(note).toHaveTextContent(/a person decides/);
  });

  it("says uploads stay out of the model in a demo world", async () => {
    renderSteward("samples_only");
    const note = await notice();
    await waitFor(() =>
      expect(note).toHaveTextContent("Your uploads aren't sent to an AI model"),
    );
    expect(note).toHaveTextContent(/only WildWorth's sample documents/);
    expect(note).toHaveTextContent(/read by a reviewer\./);
  });

  it("says the check is off where it is", async () => {
    renderSteward("off");
    const note = await notice();
    await waitFor(() =>
      expect(note).toHaveTextContent(
        "Your documents aren't sent to an AI model",
      ),
    );
    expect(note).toHaveTextContent(/is off here/);
    expect(note).toHaveTextContent(/read by a reviewer\./);
  });

  it("words it conditionally until the world is known", async () => {
    const layer = createDataLayer({
      baseUrl: BASE,
      fetch: fakeBackend({
        "GET /world": () => new Promise<Response>(() => {}),
      }).fetch,
      createEventSource: createFakeEventSource,
    });
    render(
      <WorldProvider dataLayer={layer}>
        <AiUploadNotice />
      </WorldProvider>,
    );
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent(
      /Depending on this world's settings, .* may be sent to an AI model on Nebius Token Factory/,
    );
  });
});
