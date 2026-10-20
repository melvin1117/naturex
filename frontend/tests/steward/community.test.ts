import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import {
  communityBody,
  communityFailure,
  listingAction,
  memberFailure,
  sharePct,
  validateCommunity,
} from "@/lib/community";

const COMMUNITY = "66666666-6666-4666-8666-666666666666";
const ASSET = "35df5b9e-90ff-4205-a82e-9ca6e0e06729";

describe("validateCommunity", () => {
  const ok = { name: "Selva Viva", country: "", description: "" };

  it("accepts the backend's names, any script, and an optional country", () => {
    expect(validateCommunity(ok)).toEqual({});
    expect(
      validateCommunity({
        ...ok,
        name: "  Río   Verde (Norte) ",
        country: "mx",
      }),
    ).toEqual({});
  });

  it.each([
    ["a one-letter name", { name: " x " }, "name", "Use 2–80 characters."],
    ["a long name", { name: "a".repeat(81) }, "name", "Use 2–80 characters."],
    ["punctuation first", { name: "-Selva" }, "name", /Start with a letter/],
    ["emoji", { name: "Selva 🌿" }, "name", /letters, digits/],
    ["a long country", { country: "MEX" }, "country", /two-letter/],
    [
      "a long description",
      { description: "a".repeat(1001) },
      "description",
      "Use at most 1000 characters.",
    ],
  ])("flags %s", (_case, change, field, message) => {
    const errors = validateCommunity({ ...ok, ...change });
    expect(errors[field as keyof typeof errors]).toMatch(message);
  });

  it("sends what the backend stores: trimmed, upper-case country, nulls for empty", () => {
    expect(
      communityBody({
        name: " Río  Verde ",
        country: " mx ",
        description: " ",
      }),
    ).toEqual({ name: "Río Verde", country: "MX", description: null });
  });
});

describe("communityFailure", () => {
  it("puts a taken name on the name field", () => {
    const error = new ApiError(409, "x", "community_name_taken");
    expect(communityFailure(error)).toEqual({
      field: "name",
      message: expect.stringMatching(/already exists/),
    });
  });

  it("explains the community cap above the button", () => {
    const failure = communityFailure(
      new ApiError(409, "x", "community_limit_reached"),
    );
    expect(failure.field).toBeNull();
    expect(failure.message).toMatch(/5 communities/);
  });

  it("maps a 422 to its field", () => {
    const error = new ApiError(422, "Check name", null, [
      {
        loc: ["body", "name"],
        msg: "Value error, Use letters, digits, spaces and - ' . , & ( ) only",
      },
    ]);
    expect(communityFailure(error)).toEqual({
      field: "name",
      message: "Use letters, digits, spaces and - ' . , & ( ) only.",
    });
  });

  it("falls back to the API's safe message", () => {
    expect(
      communityFailure(new ApiError(0, "Can't reach NatureX.")).message,
    ).toBe("Can't reach NatureX.");
  });

  it("explains member refusals", () => {
    expect(memberFailure(new ApiError(404, "x", "user_not_found"))).toMatch(
      /No account/,
    );
    expect(
      memberFailure(new ApiError(403, "x", "member_has_holdings")),
    ).toMatch(/sell first/);
  });
});

describe("listingAction", () => {
  it.each([
    [
      "continue_listing",
      "Continue listing",
      `/steward/list?community=${COMMUNITY}&asset=${ASSET}`,
    ],
    [
      "add_evidence",
      "Add evidence",
      `/steward/list?community=${COMMUNITY}&asset=${ASSET}`,
    ],
    ["rating_in_progress", "Rating in progress", null],
    [
      "launch_ipo",
      "Launch IPO",
      `/steward/assets/${ASSET}/ipo?community=${COMMUNITY}`,
    ],
    ["awaiting_ipo", "Waiting for the owner to launch the IPO", null],
    ["view_on_exchange", "View on Exchange", `/asset/${ASSET}`],
    ["none", "Closed", null],
  ] as const)("%s → %s", (action, label, href) => {
    expect(listingAction(action, ASSET, COMMUNITY)).toMatchObject({
      label,
      href,
    });
  });
});

describe("listingAction for suspended listings", () => {
  it("opens the Exchange once the listing has traded", () => {
    expect(
      listingAction("view_on_exchange", ASSET, COMMUNITY, "suspended"),
    ).toMatchObject({ label: "View on Exchange", href: `/asset/${ASSET}` });
  });

  it("says it's suspended, with nothing to open, before its IPO", () => {
    expect(listingAction("none", ASSET, COMMUNITY, "suspended")).toEqual({
      label: "Suspended",
      href: null,
      primary: false,
    });
    expect(listingAction("none", ASSET, COMMUNITY, "withdrawn").label).toBe(
      "Closed",
    );
  });
});

describe("sharePct", () => {
  it.each([
    ["12.50", "12.50%"],
    ["0.01", "0.01%"],
    ["0.00", "<0.01%"],
  ])("%s → %s", (pct, text) => {
    expect(sharePct(pct)).toBe(text);
  });
});
