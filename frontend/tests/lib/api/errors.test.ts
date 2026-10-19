import { describe, expect, it } from "vitest";

import {
  ApiError,
  apiErrorFromResponse,
  parseRetryAfter,
  toApiError,
  unwrap,
} from "@/lib/api/errors";

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

describe("apiErrorFromResponse", () => {
  it("maps 401 auth_required to a code and a friendly message", () => {
    const error = apiErrorFromResponse(res(401), { detail: "auth_required" });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("auth_required");
    expect(error.message).toBe("Sign in to do that.");
  });

  it("keeps a reason code on 403 but shows a friendly message", () => {
    const error = apiErrorFromResponse(res(403), { detail: "owner_only" });
    expect(error.code).toBe("owner_only");
    expect(error.message).toBe("You don't have permission to do that.");
  });

  it.each([
    ["admin_only", "Only a platform admin can do that."],
    ["sandbox_only", "That only works in a demo sandbox."],
  ])("explains the 403 reason %s (T61)", (code, message) => {
    expect(apiErrorFromResponse(res(403), { detail: code }).message).toBe(
      message,
    );
  });

  it("shows login's generic 401 and the auth rate limit's wait (T61)", () => {
    expect(
      apiErrorFromResponse(res(401), {
        detail: "Email or password is incorrect",
      }).message,
    ).toBe("Email or password is incorrect");
    expect(apiErrorFromResponse(res(401), undefined).message).toMatch(
      /session has expired/,
    );
    const limited = apiErrorFromResponse(res(429, { "Retry-After": "120" }), {
      detail: "too_many_attempts",
    });
    expect(limited.retryAfterSeconds).toBe(120);
    expect(limited.message).toBe("Too many attempts. Try again in 2 minutes.");
  });

  it.each([
    [404, "Asset not found"],
    [409, "Asset has no price yet"],
    [400, "Not enough cash"],
  ])("uses the backend's human message for %i", (status, detail) => {
    const error = apiErrorFromResponse(res(status), { detail });
    expect(error.code).toBeNull();
    expect(error.message).toBe(detail);
  });

  it("falls back to a generic message for a 404 without detail", () => {
    expect(apiErrorFromResponse(res(404), undefined).message).toBe(
      "We couldn't find that.",
    );
  });

  it("explains the first 422 validation error and keeps the details", () => {
    const detail = [
      {
        loc: ["body", "qty"],
        msg: "Input should be greater than 0",
        type: "greater_than",
      },
    ];
    const error = apiErrorFromResponse(res(422), { detail });
    expect(error.message).toBe("Check qty: Input should be greater than 0.");
    expect(error.detail).toEqual(detail);
  });

  it("reads Retry-After on 503 and says how long to wait", () => {
    const error = apiErrorFromResponse(res(503, { "Retry-After": "300" }), {
      detail: "busy_code",
    });
    expect(error.retryAfterSeconds).toBe(300);
    expect(error.message).toBe(
      "NatureX is busy right now. Try again in 5 minutes.",
    );
  });

  it("prefers the backend's human 503 message", () => {
    const error = apiErrorFromResponse(res(503, { "Retry-After": "300" }), {
      detail: "The demo is busy; try again in a few minutes",
    });
    expect(error.message).toBe("The demo is busy; try again in a few minutes");
    expect(error.retryAfterSeconds).toBe(300);
  });

  it("knows too_many_event_streams", () => {
    const error = apiErrorFromResponse(res(503, { "Retry-After": "3" }), {
      detail: "too_many_event_streams",
    });
    expect(error.code).toBe("too_many_event_streams");
    expect(error.retryAfterSeconds).toBe(3);
  });

  it("is generic for other 5xx", () => {
    expect(apiErrorFromResponse(res(500), "oops").message).toBe(
      "Something went wrong on our side. Try again.",
    );
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("5")).toBe(5);
    const now = Date.parse("2026-10-07T00:00:00Z");
    expect(parseRetryAfter("Wed, 07 Oct 2026 00:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("toApiError and unwrap", () => {
  it("turns a network failure into status 0", () => {
    const error = toApiError(new TypeError("Failed to fetch"));
    expect(error.status).toBe(0);
    expect(error.isNetworkError).toBe(true);
  });

  it("returns data on success and throws ApiError on failure", async () => {
    await expect(
      unwrap(Promise.resolve({ data: { ok: 1 }, response: res(200) })),
    ).resolves.toEqual({ ok: 1 });
    await expect(
      unwrap(
        Promise.resolve({
          error: { detail: "Asset not found" },
          response: res(404),
        }),
      ),
    ).rejects.toMatchObject({ status: 404, message: "Asset not found" });
    await expect(
      unwrap(Promise.reject(new TypeError("Failed to fetch"))),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("lets aborts through as AbortError", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(unwrap(Promise.reject(abort))).rejects.toBe(abort);
  });
});
