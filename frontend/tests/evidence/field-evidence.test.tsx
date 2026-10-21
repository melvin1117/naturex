import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FieldEvidencePanel } from "@/components/evidence/field-evidence-panel";
import { FieldEvidenceScreen } from "@/components/evidence/field-evidence-screen";
import { WorldProvider } from "@/components/world-provider";
import type {
  AssetDetail,
  FieldEvidence,
  FieldEvidencePublic,
  FieldPhoto,
} from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import {
  confidenceStory,
  photoChecks,
  photoFileProblem,
  photoVerdict,
} from "@/lib/field-evidence";

import { dropFocus } from "../focus";
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/steward/assets/${ASSET_ID}/evidence`,
  useSearchParams: () => new URLSearchParams(),
}));

const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHOTO_1 = "11111111-1111-4111-8111-111111111111";
const PHOTO_2 = "22222222-2222-4222-8222-222222222222";

beforeAll(() => {
  stubBrowserApis();
  Element.prototype.releasePointerCapture ??= () => {};
  URL.createObjectURL ??= () => "blob:photo";
  URL.revokeObjectURL ??= () => {};
});
beforeEach(() => FakeEventSource.reset());

function photo(overrides: Partial<FieldPhoto> = {}): FieldPhoto {
  return {
    id: PHOTO_1,
    asset_id: ASSET_ID,
    created_at: "2026-10-20T09:00:00Z",
    width: 1280,
    height: 960,
    size_bytes: 210_000,
    gps_check: "inside",
    gps_distance_m: 0,
    gps_buffer_m: 100,
    date_check: "ok",
    taken_on: "2026-10-18",
    max_age_days: 365,
    analysis_status: "completed",
    observation: {
      shows_landscape: true,
      land_cover: ["wetland_vegetation", "open_water"],
      disturbance: [],
      water_clarity: "clear",
      authenticity_concerns: [],
      instruction_text: false,
    },
    validated: true,
    reasons: [],
    event_id: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
}

const OUTSIDE = photo({
  id: PHOTO_2,
  gps_check: "outside",
  gps_distance_m: null,
  analysis_status: "not_run",
  observation: null,
  validated: false,
  reasons: ["gps_outside", "not_analysed"],
  event_id: null,
});

function evidence(overrides: Partial<FieldEvidence> = {}): FieldEvidence {
  return {
    photos: [],
    max_photos: 5,
    validated: 0,
    ai_analysis: "model",
    confidence: {
      current: "66.0",
      projected: "66.0",
      points: "0.0",
      counted: false,
      listing_min: "70.0",
    },
    ...overrides,
  };
}

const VALIDATED = evidence({
  photos: [photo(), OUTSIDE],
  validated: 1,
  confidence: {
    current: "66.0",
    projected: "80.0",
    points: "14.0",
    counted: false,
    listing_min: "70.0",
  },
});

/** Still below the gate with the photo: 50.0 → 64.0. */
const STILL_SHORT = evidence({
  ...VALIDATED,
  confidence: { ...VALIDATED.confidence, current: "50.0", projected: "64.0" },
});

const needsEvidence = (overrides: Partial<AssetDetail> = {}) =>
  assetFixture({
    id: ASSET_ID,
    name: "Bosque Vivo",
    status: "needs_evidence",
    community_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    trading: false,
    ipo_at: null,
    ...overrides,
  });

const ASSET = `GET /assets/${ASSET_ID}`;
const LIST = `GET /assets/${ASSET_ID}/evidence`;
const UPLOAD = `POST /assets/${ASSET_ID}/evidence`;
const SUBMIT = `POST /assets/${ASSET_ID}/submit`;
const IMAGE = (id: string) => `GET /assets/${ASSET_ID}/evidence/${id}/image`;
const DELETE = (id: string) => `DELETE /assets/${ASSET_ID}/evidence/${id}`;

type Routes = Parameters<typeof fakeBackend>[0];

function renderScreen(routes: Routes = {}) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    [ASSET]: () => json(needsEvidence()),
    [LIST]: () => json(evidence()),
    [IMAGE(PHOTO_1)]: () =>
      new Response("jpeg", { headers: { "Content-Type": "image/jpeg" } }),
    [IMAGE(PHOTO_2)]: () =>
      new Response("jpeg", { headers: { "Content-Type": "image/jpeg" } }),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <FieldEvidenceScreen assetId={ASSET_ID} />
    </WorldProvider>,
  );
  return backend;
}

describe("field evidence words", () => {
  it("describes each check from the API's results", () => {
    const near = photoChecks(photo({ gps_check: "near", gps_distance_m: 42 }));
    expect(near[0]).toMatchObject({ state: "pass" });
    expect(near[0]!.detail).toBe(
      "Taken 42 m outside the boundary, within the 100 m allowed.",
    );
    const far = photoChecks(OUTSIDE);
    expect(far.map((c) => c.state)).toEqual(["fail", "pass", "skipped"]);
    expect(far[0]!.detail).toBe("Taken more than 100 m outside the boundary.");
    expect(far[2]!.detail).toBe(
      "Not run: the location and date must pass first.",
    );
    const old = photoChecks(
      photo({ date_check: "too_old", taken_on: "2024-01-01" }),
    );
    expect(old[1]!.detail).toBe("1 Jan 2024: more than 365 days ago.");
  });

  it("names a photo's verdict", () => {
    expect(photoVerdict(photo())).toBe("validated");
    expect(
      photoVerdict(photo({ validated: false, analysis_status: "pending" })),
    ).toBe("checking");
    expect(photoVerdict(OUTSIDE)).toBe("not_counted");
  });

  it("tells the confidence effect from the API's numbers", () => {
    expect(confidenceStory(VALIDATED).title).toBe(
      "66.0% → 80.0% at the next rating",
    );
    expect(confidenceStory(evidence()).title).toBe("No validated photo yet");
    const counted = evidence({
      validated: 1,
      confidence: {
        current: "80.0",
        projected: "80.0",
        points: "0.0",
        counted: true,
        listing_min: "70.0",
      },
    });
    expect(confidenceStory(counted).title).toBe("Counted in the latest rating");
    expect(confidenceStory(STILL_SHORT).body).toContain(
      "needs at least 70.0% to list, so it would still need more evidence",
    );
    expect(confidenceStory(evidence()).body).not.toMatch(/\d+ points/);
  });

  it("never hard-codes the points: it says the API's", () => {
    const other = evidence({
      validated: 1,
      confidence: {
        current: null,
        projected: null,
        points: "9.0",
        counted: false,
        listing_min: "70.0",
      },
    });
    expect(confidenceStory(other).title).toBe("+9 points at the first rating");
    expect(confidenceStory(other).body).toContain("by 9 points");
  });

  it("checks a file before uploading it", () => {
    expect(photoFileProblem(null)).toBe("Choose a photo to upload.");
    expect(photoFileProblem({ type: "application/pdf", size: 10 })).toBe(
      "Choose a JPEG or PNG photo.",
    );
    expect(
      photoFileProblem({ type: "image/jpeg", size: 11 * 1024 * 1024 }),
    ).toBe("That photo is 11.0 MB; the limit is 10 MB.");
    expect(photoFileProblem({ type: "image/png", size: 10 })).toBeNull();
  });
});

describe("FieldEvidenceScreen", () => {
  it("shows loading, then an empty listing with the privacy and AI notes", async () => {
    renderScreen();
    expect(screen.getByText("Loading the field evidence…")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Bosque Vivo" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No photos yet/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "No validated photo yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Your location stays private")).toBeInTheDocument();
    expect(
      screen.getByText("An AI model labels your photos"),
    ).toBeInTheDocument();
  });

  it("explains a listing it can't see", async () => {
    renderScreen({
      [LIST]: () => json({ detail: "not_found" }, { status: 404 }),
    });
    expect(
      await screen.findByText("We couldn't find this site"),
    ).toBeInTheDocument();
  });

  it("checks the form, then uploads the photo as the raw body", async () => {
    const pending = photo({
      analysis_status: "pending",
      validated: false,
      observation: null,
      event_id: null,
    });
    const backend = renderScreen({
      [UPLOAD]: () => {
        // A browser drops focus from the button while it's disabled for the upload.
        dropFocus();
        return json(pending, { status: 201 });
      },
      [LIST]: sequence(
        () => json(evidence()),
        () => json(evidence({ photos: [pending] })),
        () => json(VALIDATED),
      ),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload photo" }),
    );
    expect(
      await screen.findByText("Choose a photo to upload."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Confirm you took this photo on the land and may share it.",
      ),
    ).toBeInTheDocument();
    expect(backend.calls(UPLOAD)).toBe(0);

    const file = new File(["\xff\xd8\xffjpeg"], "marsh.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(screen.getByLabelText("Photo"), {
      target: { files: [file] },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I took this photo/ }),
    );
    const upload = screen.getByRole("button", { name: "Upload photo" });
    upload.focus();
    fireEvent.click(upload);

    expect(
      await screen.findByText(/the image model is reading it/),
    ).toBeInTheDocument();
    // Focus goes back to the button once the upload ends (T48).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Upload photo" }),
      ).toHaveFocus(),
    );
    const post = backend.requests.find((r) => r.method === "POST")!;
    expect(post.headers.get("content-type")).toBe("image/jpeg");
    expect((await post.arrayBuffer()).byteLength).toBe(file.size);
    expect(await screen.findByText("Checking")).toBeInTheDocument();
  });

  it("shows each photo's checks, why one doesn't count, and the confidence effect", async () => {
    renderScreen({ [LIST]: () => json(VALIDATED) });
    expect(
      await screen.findByRole("heading", {
        name: "66.0% → 80.0% at the next rating",
      }),
    ).toBeInTheDocument();
    const first = screen.getByRole("list", { name: "Checks of photo 1" });
    expect(
      within(first).getByText(/Taken inside the listing/),
    ).toBeInTheDocument();
    expect(
      within(first).getByText(/Shows wetland vegetation and open water/),
    ).toBeInTheDocument();
    expect(screen.getByText("Counts as evidence")).toBeInTheDocument();
    const second = screen.getByRole("list", { name: "Checks of photo 2" });
    expect(within(second).getAllByText(": Failed")).toHaveLength(1);
    expect(screen.getByText("Doesn't count")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 · 1 validated")).toBeInTheDocument();
    expect(
      await screen.findAllByRole("img", { name: /Field photo/ }),
    ).toHaveLength(2);
  });

  it("sets aside a photo with injected text and says why", async () => {
    const injected = photo({
      validated: false,
      event_id: null,
      reasons: ["instruction_text"],
      observation: { ...photo().observation!, instruction_text: true },
    });
    renderScreen({ [LIST]: () => json(evidence({ photos: [injected] })) });
    expect(
      await screen.findByText(/holds text aimed at an AI model/),
    ).toBeInTheDocument();
    expect(screen.getByText("Doesn't count")).toBeInTheDocument();
  });

  it("submits a needs-evidence listing for a new rating once a photo is validated", async () => {
    const backend = renderScreen({
      [LIST]: () => json(VALIDATED),
      [SUBMIT]: () =>
        json(
          { asset_id: ASSET_ID, run_id: "r", status: "rating" },
          { status: 202 },
        ),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Submit for a new rating" }),
    );
    const heading = await screen.findByRole("heading", {
      name: "Rating again with your photos",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(backend.calls(SUBMIT)).toBe(1);
    expect(
      screen.getByRole("link", { name: /Follow the rating/ }),
    ).toHaveAttribute("href", expect.stringContaining(`asset=${ASSET_ID}`));
  });

  it("explains a listing still short of the gate and offers no new rating", async () => {
    const backend = renderScreen({ [LIST]: () => json(STILL_SHORT) });
    expect(
      await screen.findByRole("heading", {
        name: "50.0% → 64.0% at the next rating",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/so it would still need more evidence/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Submit for a new rating" }),
    ).not.toBeInTheDocument();
    expect(backend.calls(SUBMIT)).toBe(0);
  });

  it("says when AI analysis is off that photos aren't sent and can't count", async () => {
    const stored = photo({
      analysis_status: "not_run",
      observation: null,
      validated: false,
      reasons: ["not_analysed"],
      event_id: null,
    });
    renderScreen({
      [LIST]: () => json(evidence({ ai_analysis: "off", photos: [stored] })),
    });
    expect(
      await screen.findByText("AI analysis is off for now"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no photo is sent to an AI model/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/isn't sent to any AI model while AI analysis is off/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/AI analysis is off for now, so the photo can't count/),
    ).toBeInTheDocument();
    expect(screen.getByText("Doesn't count")).toBeInTheDocument();
  });

  it("asks before deleting a photo, and cancelling sends nothing", async () => {
    const backend = renderScreen({
      [LIST]: () => json(VALIDATED),
      [DELETE(PHOTO_1)]: () => new Response(null, { status: 204 }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete photo 1" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Delete photo 1?",
    });
    expect(
      within(dialog).getByText(/the next rating won't count it/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(backend.calls(DELETE(PHOTO_1))).toBe(0);
    expect(screen.getByText("Counts as evidence")).toBeInTheDocument();
  });

  it("deletes a photo and explains a refused upload", async () => {
    const backend = renderScreen({
      [LIST]: sequence(
        () => json(VALIDATED),
        () => json(evidence({ photos: [photo()], validated: 1 })),
      ),
      [DELETE(PHOTO_2)]: () => new Response(null, { status: 204 }),
      [UPLOAD]: () => json({ detail: "photo_duplicate" }, { status: 409 }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete photo 2" }),
    );
    expect(backend.calls(DELETE(PHOTO_2))).toBe(0);
    fireEvent.click(
      within(
        await screen.findByRole("alertdialog", { name: "Delete photo 2?" }),
      ).getByRole("button", { name: "Delete photo" }),
    );
    await waitFor(() => expect(backend.calls(DELETE(PHOTO_2))).toBe(1));
    await waitFor(() =>
      expect(screen.queryByText("Doesn't count")).not.toBeInTheDocument(),
    );

    const file = new File(["\xff\xd8\xff"], "again.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(screen.getByLabelText("Photo"), {
      target: { files: [file] },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I took this photo/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload photo" }));
    expect(
      await screen.findByText("That photo is already uploaded."),
    ).toBeInTheDocument();
  });

  it("stops taking photos at the limit", async () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      photo({ id: `${PHOTO_1.slice(0, -1)}${i}` }),
    );
    renderScreen({
      [LIST]: () => json(evidence({ photos: five, validated: 5 })),
    });
    expect(
      await screen.findByText(
        /This listing has 5 photos, the most it can hold/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upload photo" }),
    ).not.toBeInTheDocument();
  });
});

describe("FieldEvidencePanel", () => {
  function renderPanel(summary: FieldEvidencePublic) {
    const backend = fakeBackend({
      "GET /world": () => json(SIGNED_IN_WORLD),
      [`GET /assets/${ASSET_ID}/evidence/summary`]: () => json(summary),
    });
    const layer = createDataLayer({
      baseUrl: BASE,
      fetch: backend.fetch,
      createEventSource: createFakeEventSource,
    });
    render(
      <WorldProvider dataLayer={layer}>
        <FieldEvidencePanel assetId={ASSET_ID} />
      </WorldProvider>,
    );
  }

  it("shows counts and labels only", async () => {
    renderPanel({
      photos: 3,
      validated: 2,
      latest_taken_month: "2026-10",
      land_cover: ["wetland_vegetation", "open_water"],
      disturbance: [],
      counted_in_latest_report: true,
    });
    expect(
      await screen.findByText(/2 geotagged photos taken on the listing's land/),
    ).toBeInTheDocument();
    const seen = screen.getByRole("list", { name: "Seen on the land" });
    expect(within(seen).getByText("Wetland vegetation")).toBeInTheDocument();
    expect(screen.getByText("None seen")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.getByText(/the latest in Oct 2026, passed/),
    ).toBeInTheDocument();
  });

  it("has an empty state", async () => {
    renderPanel({
      photos: 0,
      validated: 0,
      latest_taken_month: null,
      land_cover: [],
      disturbance: [],
      counted_in_latest_report: false,
    });
    expect(
      await screen.findByText("The community hasn't added field photos yet."),
    ).toBeInTheDocument();
  });
});
