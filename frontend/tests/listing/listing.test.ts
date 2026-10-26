import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/errors";
import type { RatingRun, RatingRunStep } from "@/lib/api/types";
import {
  boundaryHint,
  clearUnsavedListing,
  FIELD_IDS,
  firstInvalidField,
  HINT_MAX_POINTS,
  MAX_PASTE_CHARS,
  outlinePolygons,
  readUnsavedListing,
  unsavedListingKey,
  writeUnsavedListing,
  boundaryPoints,
  detailsBody,
  detailsChanges,
  detailsHints,
  gateReasons,
  ipoHref,
  listingFailure,
  listingHref,
  listingOutcome,
  MAX_BOUNDARY_POINTS,
  parseBoundary,
  parseCoordinates,
  pipelineView,
  sameBoundary,
  stewardHomeHref,
  toPolygonGeoJson,
} from "@/lib/listing";
import type { LatLng } from "@/lib/site-data";

const C = "66666666-6666-4666-8666-666666666666";
const A = "33333333-3333-4333-8333-333333333333";

/** A square of `side` degrees at the equator (0.01° ≈ 1.11 km, so ≈ 123 ha). */
function square(side = 0.01, lat = 0, lon = 0): LatLng[] {
  return [
    [lat, lon],
    [lat, lon + side],
    [lat + side, lon + side],
    [lat + side, lon],
  ];
}

describe("links", () => {
  it("builds the agreed Steward links", () => {
    expect(listingHref(C)).toBe(`/steward/list?community=${C}`);
    expect(listingHref(C, A)).toBe(`/steward/list?community=${C}&asset=${A}`);
    expect(ipoHref(A, C)).toBe(
      `/steward/list?community=${C}&asset=${A}&step=offer`,
    );
    expect(stewardHomeHref(C)).toBe(`/steward?community=${C}`);
    expect(stewardHomeHref(null)).toBe("/steward");
  });
});

describe("the boundary", () => {
  it("writes a closed GeoJSON ring in [lon, lat] and reads it back", () => {
    const points = square();
    const geojson = toPolygonGeoJson(points);
    expect(geojson.type).toBe("Polygon");
    expect(geojson.coordinates[0][0]).toEqual([0, 0]);
    expect(geojson.coordinates[0][1]).toEqual([0.01, 0]);
    expect(geojson.coordinates[0].at(-1)).toEqual(geojson.coordinates[0][0]);
    expect(boundaryPoints(geojson)).toEqual(points);
    expect(sameBoundary(boundaryPoints(geojson), points)).toBe(true);
    expect(sameBoundary(points, points.slice(1))).toBe(false);
  });

  it("hints at size, shape and overlap, and shows the area", () => {
    expect(boundaryHint([])).toBeNull();
    expect(boundaryHint(square().slice(0, 2))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/three corners/),
    });
    const ok = boundaryHint(square());
    expect(ok).toMatchObject({ ok: true });
    expect(ok!.areaHa).toBeGreaterThan(120);
    expect(ok!.areaHa).toBeLessThan(126);
    expect(boundaryHint(square(0.001))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/at least 10 ha/),
    });
    expect(boundaryHint(square(3))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/at most 50,000 ha/),
    });
    const bowtie: LatLng[] = [
      [0, 0],
      [0.01, 0.01],
      [0, 0.01],
      [0.01, 0],
    ];
    expect(boundaryHint(bowtie)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/crosses itself/),
    });
    expect(
      boundaryHint(square(), [
        { name: "Laguna", polygon: square(0.01, 0.005, 0.005) },
      ]),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Laguna/) });
  });

  it("hints when a pasted boundary has too many points", () => {
    const many = Array.from(
      { length: MAX_BOUNDARY_POINTS + 1 },
      (_, i): LatLng => [
        Math.sin((i / MAX_BOUNDARY_POINTS) * 2 * Math.PI) * 0.01,
        Math.cos((i / MAX_BOUNDARY_POINTS) * 2 * Math.PI) * 0.01,
      ],
    );
    expect(boundaryHint(many)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Simplify it to at most 10,000/),
    });
  });

  it("parses a pasted GeoJSON Polygon, Feature or one-part MultiPolygon", () => {
    const ring = [
      [-99.1, 19.2],
      [-99.09, 19.2],
      [-99.09, 19.21],
      [-99.1, 19.2],
    ];
    const expected = [
      [19.2, -99.1],
      [19.2, -99.09],
      [19.21, -99.09],
    ];
    expect(
      parseBoundary(JSON.stringify({ type: "Polygon", coordinates: [ring] })),
    ).toEqual({ ok: true, points: expected });
    expect(
      parseBoundary(
        JSON.stringify({
          type: "Feature",
          properties: { owner: "<script>" },
          geometry: { type: "Polygon", coordinates: [ring] },
        }),
      ),
    ).toEqual({ ok: true, points: expected });
    expect(
      parseBoundary(
        JSON.stringify({ type: "MultiPolygon", coordinates: [[ring]] }),
      ),
    ).toEqual({ ok: true, points: expected });
  });

  it("refuses pasted boundaries it can't list", () => {
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    const bad = (value: unknown) =>
      parseBoundary(typeof value === "string" ? value : JSON.stringify(value));
    expect(bad("{not json")).toMatchObject({ ok: false });
    expect(bad({ type: "Point", coordinates: [0, 0] })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Polygon/),
    });
    expect(bad({ type: "Polygon", coordinates: [ring, ring] })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/holes/),
    });
    expect(
      bad({ type: "MultiPolygon", coordinates: [[ring], [ring]] }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/several/) });
    expect(
      bad({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [200, 0],
            [1, 1],
          ],
        ],
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/WGS84/) });
    expect(
      bad({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            ["a", 1],
            [1, 1],
          ],
        ],
      }),
    ).toMatchObject({ ok: false });
    expect(
      bad({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/three/) });
  });

  it("reads typed coordinates", () => {
    expect(parseCoordinates("19.29, -99.10")).toEqual([19.29, -99.1]);
    expect(parseCoordinates(" -3.5 120 ")).toEqual([-3.5, 120]);
    expect(parseCoordinates("91, 0")).toBeNull();
    expect(parseCoordinates("Mexico City")).toBeNull();
  });
});

describe("the details", () => {
  const form = {
    name: "  Laguna   Verde ",
    country: "mx",
    description: "  ",
    attestation: true,
  };

  it("hints like the backend checks", () => {
    expect(detailsHints(form, { needsAttestation: true })).toEqual({});
    expect(
      detailsHints(
        {
          name: "L",
          country: "Mex",
          description: "x".repeat(1001),
          attestation: false,
        },
        { needsAttestation: true },
      ),
    ).toEqual({
      name: expect.any(String),
      country: expect.any(String),
      description: expect.any(String),
      attestation: expect.any(String),
    });
    expect(
      detailsHints(
        { ...form, attestation: false },
        { needsAttestation: false },
      ),
    ).toEqual({});
  });

  it("cleans the body and sends only what changed", () => {
    expect(detailsBody(form)).toEqual({
      name: "Laguna Verde",
      country: "MX",
      description: null,
    });
    const saved = { name: "Laguna Verde", country: "MX", description: null };
    expect(detailsChanges(saved, form)).toEqual({});
    expect(
      detailsChanges(saved, { ...form, country: "", description: "Wetland" }),
    ).toEqual({ country: null, description: "Wetland" });
  });
});

const err = (
  status: number,
  detail: unknown,
  retryAfter: number | null = null,
) =>
  new ApiError(
    status,
    "fallback message",
    typeof detail === "string" ? detail : null,
    detail,
    retryAfter,
  );

describe("listingFailure: every T58 error code", () => {
  it("409 listing_limit_reached points to the Listings page", () => {
    const f = listingFailure(err(409, "listing_limit_reached"));
    expect(f.limitReached).toBe(true);
    expect(f.title).toMatch(/Too many listings/);
  });

  it("409 cannot_<event>_<status> says where the listing is now", () => {
    expect(listingFailure(err(409, "cannot_edit_rating")).message).toMatch(
      /being rated now, so it can't be edited/,
    );
    expect(listingFailure(err(409, "cannot_submit_listed")).message).toMatch(
      /listed now, so it can't be submitted for rating/,
    );
    expect(
      listingFailure(err(409, "cannot_withdraw_needs_evidence")).message,
    ).toMatch(/waiting for evidence/);
  });

  it.each([
    ["metrics_unavailable", /no satellite data/i],
    ["evidence_required", /new field evidence or newer satellite data/],
    ["overlap", /submitted before yours/],
    ["run_in_progress", /progress shows here/],
    ["members_only", /owner and stewards/],
  ])("409/403 %s", (code, message) => {
    expect(listingFailure(err(409, code)).message).toMatch(message);
  });

  it("429s and 503 show the wait from Retry-After", () => {
    expect(listingFailure(err(429, "edit_rate_limited", 120)).message).toMatch(
      /Try again in 2 minutes/,
    );
    expect(listingFailure(err(429, "resubmit_cooldown", 540)).message).toMatch(
      /submit it again in 9 minutes/,
    );
    expect(listingFailure(err(429, "rating_rate_limited", 30)).message).toMatch(
      /30 seconds/,
    );
    expect(
      listingFailure(err(429, "rating_global_limit", null)).message,
    ).toMatch(/a moment/);
    expect(listingFailure(err(503, "rating_busy", 5)).retryAfterSeconds).toBe(
      5,
    );
  });

  it("live-world live rating limits say what happened and when to retry", () => {
    const quota = listingFailure(err(429, "live_rating_quota", 4 * 3600));
    expect(quota.title).toMatch(/live ratings are used/);
    expect(quota.message).toMatch(
      /unchanged\. You can submit it in about 4 hours/,
    );
    expect(
      listingFailure(err(429, "live_rating_global_limit", 1800)).message,
    ).toMatch(/each day\. Your listing is unchanged\. Try again in 30 minutes/);
    expect(
      listingFailure(err(429, "live_rating_global_limit", 3600)).message,
    ).toMatch(/about an hour/);
    expect(listingFailure(err(429, "live_rating_quota", null)).message).toMatch(
      /in a few hours/,
    );
    expect(listingFailure(err(409, "live_area_too_large")).message).toMatch(
      /too large for a live satellite rating\. Draw a smaller area/,
    );
  });

  it("422 polygon problems come back one per issue", () => {
    const f = listingFailure(
      err(422, [
        {
          type: "polygon.too_small",
          loc: ["body", "geojson"],
          msg: "The area is 3.3 ha; the minimum is 10 ha.",
        },
        {
          type: "polygon.overlap",
          loc: ["body", "geojson"],
          msg: "This area overlaps another listing. Redraw around it.",
        },
      ]),
    );
    expect(f.title).toBe("Check the boundary");
    expect(f.polygon).toEqual([
      {
        code: "too_small",
        title: "Too small",
        message: "The area is 3.3 ha; the minimum is 10 ha.",
      },
      {
        code: "overlap",
        title: "Overlap",
        message: "This area overlaps another listing. Redraw around it.",
      },
    ]);
  });

  it("422 field errors map to their fields", () => {
    const f = listingFailure(
      err(422, [
        {
          type: "value_error",
          loc: ["body", "name"],
          msg: "Value error, Use 2–80 characters",
        },
        {
          type: "value_error",
          loc: ["body", "attestation"],
          msg: "Value error, Confirm that your community has the right",
        },
      ]),
    );
    expect(f.polygon).toEqual([]);
    expect(f.fields).toEqual({
      name: "Use 2–80 characters",
      attestation: "Confirm that your community has the right",
    });
  });

  it("falls back to the friendly message", () => {
    expect(listingFailure(err(404, "not_found")).message).toMatch(/Refresh/);
    expect(listingFailure(err(500, null)).message).toBe("fallback message");
  });
});

const step = (
  name: string,
  status: string,
  extra: Partial<RatingRunStep> = {},
): RatingRunStep => ({
  step: name,
  status,
  prompt_tokens: 0,
  completion_tokens: 0,
  ...extra,
});

function run(overrides: Partial<RatingRun> = {}): RatingRun {
  return {
    run_id: "88888888-8888-4888-8888-888888888888",
    asset_id: A,
    status: "running",
    degraded: false,
    reasons: [],
    steps: [],
    ...overrides,
  };
}

const states = (view: ReturnType<typeof pipelineView>) =>
  Object.fromEntries(view.stages.map((s) => [s.step, s.state]));

describe("pipelineView: the progress steps", () => {
  it("shows a queued run waiting for a worker", () => {
    const view = pipelineView(
      run({ status: "queued", steps: [step("queued", "queued")] }),
    );
    expect(view.phase).toBe("queued");
    expect(states(view)).toMatchObject({
      queued: "running",
      earth_obs: "waiting",
      done: "waiting",
    });
    // The status line says "Queued…" once; no stage name repeats it.
    expect(view.current).toBeNull();
  });

  it("lights each step the run has reached", () => {
    const view = pipelineView(
      run({
        status: "queued",
        steps: [
          step("queued", "queued"),
          step("started", "running"),
          step("earth_obs", "ok", { latency_ms: 1200 }),
          step("valuation", "ok", { latency_ms: 40 }),
        ],
      }),
    );
    expect(view.phase).toBe("running");
    expect(states(view)).toMatchObject({
      queued: "done",
      earth_obs: "done",
      valuation: "done",
      news: "running",
      evidence: "waiting",
      audit: "waiting",
      done: "waiting",
    });
    expect(view.current).toBe("Local news");
    expect(view.stages[1].latencyMs).toBe(1200);
  });

  it("ends succeeded, with skipped steps marked", () => {
    const view = pipelineView(
      run({
        status: "succeeded",
        steps: [
          step("queued", "queued"),
          step("started", "running"),
          step("earth_obs", "ok"),
          step("valuation", "ok"),
          step("news", "ok", { model: "nemotron" }),
          step("evidence", "skipped"),
          step("audit", "ok"),
          step("done", "succeeded"),
        ],
      }),
    );
    expect(view.phase).toBe("succeeded");
    expect(states(view)).toMatchObject({ evidence: "skipped", done: "done" });
    expect(view.stages[3].model).toBe("nemotron");
    expect(view.current).toBeNull();
  });

  it("flags a fallback and a degraded run", () => {
    const view = pipelineView(
      run({
        status: "degraded",
        degraded: true,
        reasons: ["orchestrator_fallback"],
        steps: [step("fallback", "ok"), step("done", "degraded")],
      }),
    );
    expect(view.fallback).toBe(true);
    expect(view.degraded).toBe(true);
    expect(view.reasons).toEqual(["orchestrator_fallback"]);
  });

  it("shows where a failed or stale run stopped", () => {
    const failed = pipelineView(
      run({
        status: "running",
        steps: [
          step("queued", "queued"),
          step("started", "running"),
          step("earth_obs", "failed", { error: "no_cached_metrics" }),
          step("done", "failed", {
            error: "earth_obs_failed:no_cached_metrics",
          }),
        ],
      }),
    );
    expect(failed.phase).toBe("failed");
    expect(states(failed)).toMatchObject({
      earth_obs: "failed",
      valuation: "skipped",
      done: "failed",
    });
    expect(failed.error).toBe("earth_obs_failed:no_cached_metrics");

    const stale = pipelineView(
      run({
        status: "failed",
        error: "stale",
        steps: [step("queued", "queued")],
      }),
    );
    expect(stale.phase).toBe("failed");
    expect(stale.error).toBe("stale");
  });
});

describe("listingOutcome: each outcome", () => {
  const at = (
    status: Parameters<typeof listingOutcome>[0]["status"],
    status_reason: string | null = null,
    trading = false,
  ) => listingOutcome({ status, status_reason, trading });

  it("listed and suspended", () => {
    expect(at("listed")).toMatchObject({
      kind: "listed",
      message: expect.stringMatching(/opening offer/),
    });
    expect(at("listed", null, true).message).toMatch(/trading is open/);
    expect(at("suspended", "data_dispute").message).toMatch(/under review/);
    expect(at("suspended", "verification_revoked").message).toMatch(
      /verification was revoked/,
    );
  });

  it("needs_evidence explains and offers revise", () => {
    const outcome = at("needs_evidence", "confidence_below_70");
    expect(outcome).toMatchObject({
      kind: "needs_evidence",
      canRevise: true,
      canWithdraw: true,
      canRetry: false,
    });
    expect(outcome.message).toMatch(/confidence is below 70%/);
  });

  it("ineligible explains each gate reason, with no way back", () => {
    const outcome = at(
      "ineligible",
      "grade_below_c,forest_loss_last_12m_at_least_1pct_of_area",
    );
    expect(outcome).toMatchObject({
      kind: "ineligible",
      canRevise: false,
      canRetry: false,
    });
    expect(outcome.message).toMatch(/below C/);
    expect(outcome.message).toMatch(/Forest loss/);
    expect(gateReasons("new_reason,other_reason")).toEqual([
      "It didn't pass one of the listing checks.",
    ]);
    expect(outcome.message).not.toMatch(/_/);
  });

  it("rating: active, waiting for satellite data, stale or failed", () => {
    expect(at("rating")).toMatchObject({ kind: "rating", canRetry: false });
    expect(at("rating", "no_satellite_metrics")).toMatchObject({
      kind: "waiting_for_data",
      canRetry: true,
      message: expect.stringMatching(/Try again later/),
    });
    expect(at("rating", "rating_stale")).toMatchObject({
      kind: "stale",
      canRetry: true,
    });
    const failed = at("rating", "rating_failed:llm_unavailable");
    expect(failed).toMatchObject({ kind: "failed", canRetry: true });
    expect(failed.message).not.toMatch(/llm_unavailable/);
  });

  it("draft and withdrawn", () => {
    expect(at("draft")).toMatchObject({ kind: "draft", canWithdraw: true });
    expect(at("withdrawn")).toMatchObject({
      kind: "withdrawn",
      canWithdraw: false,
    });
  });
});

/** A regular polygon of `n` corners around (lat, lon), `radius` degrees across. */
function circle(n: number, radius = 0.01, lat = 0, lon = 0): LatLng[] {
  return Array.from({ length: n }, (_, i): LatLng => [
    lat + radius * Math.sin((i / n) * 2 * Math.PI),
    lon + radius * Math.cos((i / n) * 2 * Math.PI),
  ]);
}

describe("big boundaries can't freeze the tab", () => {
  it("refuses pasted text over the limit before parsing it", () => {
    const parse = vi.spyOn(JSON, "parse");
    const result = parseBoundary(" ".repeat(MAX_PASTE_CHARS + 1));
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/too much text/),
    });
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("refuses a pasted ring over 10,000 corners", () => {
    const ring = circle(10_050).map(([lat, lon]) => [lon, lat]);
    expect(
      parseBoundary(
        JSON.stringify({ type: "Polygon", coordinates: [[...ring, ring[0]]] }),
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/more than 10,000 corners/),
    });
    const ok = circle(10_000).map(([lat, lon]) => [lon, lat]);
    expect(
      parseBoundary(
        JSON.stringify({ type: "Polygon", coordinates: [[...ok, ok[0]]] }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("checks only the size above HINT_MAX_POINTS corners, and says the server checks the rest", () => {
    const big = circle(HINT_MAX_POINTS + 1);
    const started = performance.now();
    const hint = boundaryHint(big, [{ name: "Laguna", polygon: big }]);
    expect(performance.now() - started).toBeLessThan(500);
    expect(hint).toMatchObject({ ok: true, checked: "size" });
    expect(boundaryHint(circle(HINT_MAX_POINTS + 1, 0.0001))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/at least 10 ha/),
    });
    expect(boundaryHint(circle(HINT_MAX_POINTS))).toMatchObject({
      checked: "all",
    });
  });

  it("only compares outlines whose boxes touch the boundary", () => {
    const far = { name: "Far", polygon: circle(200, 0.01, 40, 40) };
    const near = { name: "Near", polygon: circle(200, 0.01, 0.005, 0.005) };
    expect(boundaryHint(circle(500), [far])).toMatchObject({ ok: true });
    expect(boundaryHint(circle(500), [far, near])).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Near/),
    });
  });

  it("says when overlap couldn't be checked against every site", () => {
    expect(boundaryHint(square(), [], { complete: false })).toMatchObject({
      ok: true,
      checked: "no-overlap",
    });
  });
});

describe("outlines from GET /assets/outlines", () => {
  it("become [lat, lon] polygons, one per part, without the listing itself", () => {
    const outlines = [
      {
        id: "a",
        name: "Laguna",
        rings: [
          [
            [-99, 19],
            [-98.99, 19],
            [-98.99, 19.01],
            [-99, 19],
          ],
          [
            [1, 1],
            [2, 2],
          ],
        ],
      },
      {
        id: "mine",
        name: "Mine",
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    ];
    expect(outlinePolygons(outlines, "mine")).toEqual([
      {
        name: "Laguna",
        polygon: [
          [19, -99],
          [19, -98.99],
          [19.01, -98.99],
          [19, -99],
        ],
      },
    ]);
    expect(outlinePolygons(undefined)).toEqual([]);
  });
});

describe("the form's fields", () => {
  it("has prefixed IDs and finds the first invalid field in form order", () => {
    expect(Object.values(FIELD_IDS)).toEqual([
      "listing-name",
      "listing-country",
      "listing-description",
      "listing-attestation",
    ]);
    expect(firstInvalidField({ attestation: "x", country: "y" })).toBe(
      "country",
    );
    expect(firstInvalidField({})).toBeNull();
  });

  it("keeps an unsaved listing in this tab, per account and community", () => {
    const key = unsavedListingKey("me", "c");
    expect(key).toBe("ww-listing-draft:me:c");
    writeUnsavedListing(key, {
      form: { name: "Laguna", country: "MX", description: "" },
      points: square(),
    });
    expect(readUnsavedListing(key)).toEqual({
      form: { name: "Laguna", country: "MX", description: "" },
      points: square(),
    });
    expect(readUnsavedListing(unsavedListingKey("other", "c"))).toBeNull();
    window.sessionStorage.setItem(key, "{not json");
    expect(readUnsavedListing(key)).toBeNull();
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ form: {}, points: [["x", 1]] }),
    );
    expect(readUnsavedListing(key)).toBeNull();
    writeUnsavedListing(key, {
      form: { name: " ", country: "MX", description: "" },
      points: [],
    });
    expect(window.sessionStorage.getItem(key)).toBeNull();
    writeUnsavedListing(key, {
      form: { name: "x", country: "", description: "" },
      points: [],
    });
    clearUnsavedListing(key);
    expect(readUnsavedListing(key)).toBeNull();
  });
});

describe("more error wording", () => {
  it("401 says the sandbox ended and offers a new one", () => {
    expect(listingFailure(err(401, "auth_required"))).toMatchObject({
      signIn: true,
      title: "Your sandbox has ended",
    });
  });

  it("names every refused event", () => {
    expect(listingFailure(err(409, "cannot_create_listed")).message).toMatch(
      /can't be created/,
    );
    expect(listingFailure(err(409, "cannot_rated_draft")).message).toMatch(
      /can't be rated/,
    );
  });
});
