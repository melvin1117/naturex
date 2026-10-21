import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { StewardVerifyScreen } from "@/components/verification/steward-verify-screen";
import { WorldProvider } from "@/components/world-provider";
import type { AssetDetail } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";

import { stubBrowserApis } from "../exchange/render";
import {
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
  ASSET_ID,
  DOC_MINUTES,
  DOC_TITLE,
  document,
  panel,
  run,
  verifiedPanel,
  verifiedRun,
} from "./fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/steward/assets/${ASSET_ID}/verify`,
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  stubBrowserApis();
  Element.prototype.releasePointerCapture ??= () => {};
});
beforeEach(() => FakeEventSource.reset());

const ASSET = `GET /assets/${ASSET_ID}`;
const RUNS = `GET /assets/${ASSET_ID}/verification/runs`;
const DOCS = `GET /assets/${ASSET_ID}/documents`;
const UPLOAD = `POST /assets/${ASSET_ID}/documents`;
const SUBMIT = `POST /assets/${ASSET_ID}/verification/runs`;
const PANEL = `GET /assets/${ASSET_ID}/verification`;
const REVOKED_RUN = run({
  id: "99999999-9999-4999-8999-999999999999",
  is_current: false,
  level: "revoked",
  effective_level: "revoked",
  reviewer_role: "platform_admin",
  decided_at: "2026-10-19T09:00:00Z",
  revoke_reason: "A boundary dispute.",
  revoked_at: "2026-10-19T12:00:00Z",
});
const revokedPanel = panel({
  level: "revoked",
  badge: "Verification revoked",
  revoked_at: "2026-10-19T12:00:00Z",
  ledger_seq: 9,
});

const unlaunched = (overrides: Partial<AssetDetail> = {}) =>
  assetFixture({
    name: "Río Claro Forest",
    trading: false,
    ipo_at: null,
    ...overrides,
  });

type Routes = Parameters<typeof fakeBackend>[0];

function renderScreen(routes: Routes = {}) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    [ASSET]: () => json(unlaunched()),
    [RUNS]: () => json([]),
    [DOCS]: () => json([]),
    [PANEL]: () => json(panel()),
    ...routes,
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
  return backend;
}

async function chooseType(name: string) {
  const trigger = screen.getByRole("combobox", { name: "What is it?" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name }));
  // Radix hands focus back to the trigger once the list has closed.
  await waitFor(() => expect(trigger).toHaveFocus());
}

describe("StewardVerifyScreen", () => {
  it("shows loading, then a listing with no submission as self-attested", async () => {
    renderScreen();
    expect(
      screen.getByText("Loading the verification record…"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Río Claro Forest",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Self-attested by the community"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Not verified yet" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Launch the opening offer/ }),
    ).not.toBeInTheDocument();
  });

  it("explains a listing it can't see", async () => {
    renderScreen({
      [RUNS]: () => json({ detail: "not_found" }, { status: 404 }),
    });
    expect(
      await screen.findByText("We couldn't find this site"),
    ).toBeInTheDocument();
  });

  it("shows a load error with a retry", async () => {
    renderScreen({
      [RUNS]: sequence(
        () => json({ detail: "boom" }, { status: 500 }),
        () => json([]),
      ),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Not verified yet" }),
    ).toBeInTheDocument();
  });

  it("checks the form before uploading", async () => {
    const backend = renderScreen();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload document" }),
    );
    expect(
      await screen.findByText("Choose what the document is."),
    ).toBeInTheDocument();
    expect(screen.getByText("Choose a file to upload.")).toBeInTheDocument();
    expect(
      screen.getByText("Confirm you're authorised to share this document."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("File")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["x"], "scan.gif", { type: "image/gif" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(
      await screen.findByText("Choose a PDF, JPEG or PNG file."),
    ).toBeInTheDocument();
    expect(backend.calls(UPLOAD)).toBe(0);
  });

  it("uploads a document as the raw body, then submits it for review", async () => {
    const uploaded = document({
      id: DOC_MINUTES,
      doc_type: "assembly_minutes",
    });
    const backend = renderScreen({
      [DOCS]: sequence(
        () => json([document()]),
        () => json([document(), uploaded]),
        () =>
          json([
            document({ run_id: run().id }),
            { ...uploaded, run_id: run().id },
          ]),
      ),
      [UPLOAD]: () => json(uploaded, { status: 201 }),
      [SUBMIT]: () => json(run(), { status: 201 }),
      [RUNS]: sequence(
        () => json([]),
        () => json([run()]),
      ),
    });
    await screen.findByText("Land title");

    await chooseType("Assembly minutes (consent)");
    const file = new File(["%PDF-1.7 minutes"], "minutes.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /authorised/ }));
    // A browser drops focus from the button while it's disabled for the upload.
    (globalThis.document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));

    expect(
      await screen.findByText("Uploaded: Assembly minutes (consent)."),
    ).toBeInTheDocument();
    // ...and gets it back afterwards (T48).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Upload document" }),
      ).toHaveFocus(),
    );
    const post = backend.requests.find((r) => r.method === "POST")!;
    const url = new URL(post.url);
    expect(url.searchParams.get("doc_type")).toBe("assembly_minutes");
    expect(post.headers.get("content-type")).toBe("application/pdf");
    expect(await post.text()).toBe("%PDF-1.7 minutes");

    // The new document is picked for submission; add the title too.
    const minutes = await screen.findByRole("checkbox", {
      name: /Assembly minutes \(consent\)/,
    });
    await waitFor(() => expect(minutes).toBeChecked());
    fireEvent.click(screen.getByRole("checkbox", { name: /Land title/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Submit 2 documents for review" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Waiting for a reviewer" }),
    ).toBeInTheDocument();
    const submit = backend.requests.find(
      (r) => r.method === "POST" && r.url.endsWith("/verification/runs"),
    )!;
    expect((await submit.json()).document_ids.sort()).toEqual(
      [DOC_MINUTES, DOC_TITLE].sort(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Waiting for a reviewer" }),
      ).toHaveFocus(),
    );
    const checks = screen.getByRole("list", { name: "Automated checks" });
    expect(within(checks).getByText("no overlap")).toBeInTheDocument();
  }, 15_000);

  it("explains an upload the backend refused", async () => {
    renderScreen({
      [UPLOAD]: () => json({ detail: "pdf_encrypted" }, { status: 422 }),
    });
    await screen.findByText(/No documents yet/);
    await chooseType("Land title");
    fireEvent.change(screen.getByLabelText("File"), {
      target: {
        files: [new File(["%PDF"], "t.pdf", { type: "application/pdf" })],
      },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /authorised/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That PDF is password-protected or encrypted. Upload an unprotected copy.",
    );
  });

  it("shows a rejection's reason and the checklist values", async () => {
    renderScreen({
      [RUNS]: () =>
        json([
          run({
            level: "rejected",
            effective_level: "rejected",
            reviewer_role: "platform_admin",
            decided_at: "2026-10-19T09:00:00Z",
            reason: "The minutes are unsigned.",
          }),
        ]),
    });
    expect(
      await screen.findByRole("heading", {
        name: "The reviewer rejected these documents",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Reviewer's reason for rejecting"),
    ).toBeInTheDocument();
    expect(screen.getByText("The minutes are unsigned.")).toBeInTheDocument();
    expect(screen.getByText("NatureX platform admin")).toBeInTheDocument();
    expect(
      screen.getByText("2 of 2 bound to this listing"),
    ).toBeInTheDocument();
  });

  it("shows the Exchange's badge for a verified listing and offers the opening offer", async () => {
    renderScreen({
      [RUNS]: () => json([verifiedRun()]),
      [PANEL]: () => json(verifiedPanel()),
    });
    expect(
      await screen.findAllByText(
        "Documents reviewed by NatureX (hackathon process)",
      ),
    ).not.toHaveLength(0);
    expect(
      screen.getByRole("link", { name: /Launch the opening offer/ }),
    ).toHaveAttribute("href", `/steward/assets/${ASSET_ID}/ipo`);
  });

  it("uses the API's sample wording for a verified run of sample documents", async () => {
    renderScreen({
      [RUNS]: () =>
        json([verifiedRun({ evidence_kind: "sample", mode: "demo" })]),
      [PANEL]: () =>
        json(
          verifiedPanel({
            badge:
              "Demo verification: sample documents, no real ownership checked",
          }),
        ),
    });
    expect(
      await screen.findAllByText(
        "Demo verification: sample documents, no real ownership checked",
      ),
    ).not.toHaveLength(0);
    expect(
      screen.queryByText("Documents reviewed by NatureX (hackathon process)"),
    ).not.toBeInTheDocument();
  });

  it("keeps saying a revocation stands after a new submission", async () => {
    renderScreen({
      [ASSET]: () => json(unlaunched({ status: "suspended", trading: true })),
      [RUNS]: () => json([run(), REVOKED_RUN]),
      [PANEL]: () => json(revokedPanel),
    });
    expect(
      await screen.findByText(/A revocation still stands/),
    ).toBeInTheDocument();
    expect(screen.getByText("Verification revoked")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Waiting for a reviewer" }),
    ).toBeInTheDocument();
    expect(screen.getByText("A boundary dispute.")).toBeInTheDocument();
  });

  it("drops the revocation once a later run was approved, even with a newer submission", async () => {
    const approved = verifiedRun({
      id: "aaaaaaaa-0000-4000-8000-000000000000",
      is_current: false,
    });
    renderScreen({
      [RUNS]: () => json([run(), approved, REVOKED_RUN]),
      [PANEL]: () => json(panel({ level: "documents_submitted" })),
    });
    expect(
      await screen.findByRole("heading", { name: "Waiting for a reviewer" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Self-attested by the community"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/A revocation still stands/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Verification revoked")).not.toBeInTheDocument();
  });

  it("doesn't upload a file of a type it can't accept", async () => {
    const backend = renderScreen();
    await screen.findByText(/No documents yet/);
    await chooseType("Land title");
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["x"], "scan", { type: "" })] },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /authorised/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(
      await screen.findByText("Choose a PDF, JPEG or PNG file."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("File")).toHaveFocus();
    expect(backend.calls(UPLOAD)).toBe(0);
  });

  it("won't take documents for a withdrawn listing", async () => {
    renderScreen({ [ASSET]: () => json(unlaunched({ status: "withdrawn" })) });
    expect(
      await screen.findByText("This listing can't be verified"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upload document" }),
    ).toBeDisabled();
  });
});
