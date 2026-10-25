import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProveStep } from "@/components/listing/prove-step";
import { WorldProvider } from "@/components/world-provider";
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
import { ASSET_ID, DOC_MINUTES, document, run } from "../verification/fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/steward/list",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  stubBrowserApis();
  Element.prototype.releasePointerCapture ??= () => {};
});
beforeEach(() => FakeEventSource.reset());

const RUNS = `GET /assets/${ASSET_ID}/verification/runs`;
const UPLOAD = `POST /assets/${ASSET_ID}/documents`;
const SUBMIT = `POST /assets/${ASSET_ID}/verification/runs`;

type Routes = Parameters<typeof fakeBackend>[0];

function renderProve(routes: Routes = {}) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    [RUNS]: () => json([]),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <ProveStep
        asset={assetFixture({ id: ASSET_ID, name: "Río Claro Forest" })}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />
    </WorldProvider>,
  );
  return backend;
}

async function chooseType(name: string) {
  const trigger = await screen.findByRole("combobox", { name: "What is it?" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name }));
  await waitFor(() => expect(trigger).toHaveFocus());
}

function chooseFile(file: File) {
  fireEvent.change(screen.getByLabelText("File"), {
    target: { files: [file] },
  });
}

const pdf = (body = "%PDF-1.7 minutes", name = "minutes.pdf") =>
  new File([body], name, { type: "application/pdf" });

describe("the Prove step's uploads", () => {
  it("checks the form before uploading", async () => {
    const backend = renderProve();
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

    chooseFile(new File(["x"], "scan.gif", { type: "image/gif" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(
      await screen.findByText("Choose a PDF, JPEG or PNG file."),
    ).toBeInTheDocument();
    expect(backend.calls(UPLOAD)).toBe(0);
  });

  it("uploads a document as the raw body and sends it to the Reviewer at once", async () => {
    const uploaded = document({
      id: DOC_MINUTES,
      doc_type: "assembly_minutes",
    });
    const backend = renderProve({
      [UPLOAD]: () => json(uploaded, { status: 201 }),
      [SUBMIT]: () =>
        json(run({ documents: [{ ...uploaded, submitted: true }] }), {
          status: 201,
        }),
      [RUNS]: sequence(
        () => json([]),
        () => json([run({ documents: [{ ...uploaded, submitted: true }] })]),
      ),
    });

    await chooseType("Assembly minutes (consent)");
    chooseFile(pdf());
    fireEvent.click(screen.getByRole("checkbox", { name: /authorised/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));

    const sent = await screen.findByRole("list", {
      name: "Sent to the Reviewer",
    });
    expect(sent).toHaveTextContent("Assembly minutes (consent)");
    const post = backend.requests.find((r) => r.url.includes("/documents?"))!;
    expect(new URL(post.url).searchParams.get("doc_type")).toBe(
      "assembly_minutes",
    );
    expect(post.headers.get("content-type")).toBe("application/pdf");
    expect(await post.text()).toBe("%PDF-1.7 minutes");
    const submit = backend.requests.find(
      (r) => r.method === "POST" && r.url.endsWith("/verification/runs"),
    )!;
    expect(await submit.json()).toEqual({ document_ids: [DOC_MINUTES] });
    expect(
      screen.getByRole("button", { name: /Continue to your offer/ }),
    ).toBeVisible();
  });

  it("explains an upload the backend refused", async () => {
    renderProve({
      [UPLOAD]: () => json({ detail: "pdf_encrypted" }, { status: 422 }),
    });
    await chooseType("Land title");
    chooseFile(pdf("%PDF", "t.pdf"));
    fireEvent.click(screen.getByRole("checkbox", { name: /authorised/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(
      await screen.findByText(
        "That PDF is password-protected or encrypted. Upload an unprotected copy.",
      ),
    ).toBeVisible();
  });

  it("explains a submission the backend refused, in words", async () => {
    renderProve({
      [UPLOAD]: () => json(document(), { status: 201 }),
      [SUBMIT]: () => json({ detail: "submission_full" }, { status: 409 }),
    });
    await chooseType("Land title");
    chooseFile(pdf("%PDF", "t.pdf"));
    fireEvent.click(screen.getByRole("checkbox", { name: /authorised/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(
      await screen.findByText("We couldn't send that document"),
    ).toBeVisible();
    expect(
      screen.getByText("A submission holds at most 3 documents."),
    ).toBeVisible();
  });

  it("stops taking documents at three, notice and form included", async () => {
    const third = document({
      id: "88888888-8888-4888-8888-888888888883",
      doc_type: "other",
      submitted: true,
    });
    renderProve({
      [RUNS]: () => json([run({ documents: [...run().documents, third] })]),
    });
    expect(
      await screen.findByText(/That's the most a submission takes/),
    ).toBeVisible();
    expect(screen.queryByLabelText("File")).not.toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
