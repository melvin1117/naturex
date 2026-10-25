import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import type { ListingVerification } from "@/lib/api/types";
import {
  communityBody,
  communityFailure,
  listingAction,
  memberFailure,
  openingChecklist,
  validateCommunity,
  verificationChip,
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
      communityFailure(new ApiError(0, "Can't reach WildWorth.")).message,
    ).toBe("Can't reach WildWorth.");
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
      "verify",
      "Verify this listing",
      `/steward/list?community=${COMMUNITY}&asset=${ASSET}&step=prove`,
    ],
    [
      "verification_in_review",
      "See your submission",
      `/steward/list?community=${COMMUNITY}&asset=${ASSET}&step=prove`,
    ],
    [
      "launch_ipo",
      "Send your offer",
      `/steward/list?community=${COMMUNITY}&asset=${ASSET}&step=offer`,
    ],
    ["awaiting_ipo", "Waiting for the owner to open it to supporters", null],
    ["awaiting_verification", "Waiting for verification", null],
    ["view_on_exchange", "View on Marketplace", `/asset/${ASSET}`],
    ["none", "Closed", null],
  ] as const)("%s → %s", (action, label, href) => {
    expect(listingAction(action, ASSET, COMMUNITY)).toMatchObject({
      label,
      href,
    });
  });
});

describe("listingAction never points at a locked door (#216)", () => {
  const ipo = `/steward/list?community=${COMMUNITY}&asset=${ASSET}&step=offer`;
  const verify = `/steward/list?community=${COMMUNITY}&asset=${ASSET}&step=prove`;

  it("makes verifying the main action, with the offer as a preview beside it", () => {
    expect(listingAction("verify", ASSET, COMMUNITY, "listed")).toEqual({
      label: "Verify this listing",
      href: verify,
      primary: true,
      secondary: { label: "Preview the opening offer", href: ipo },
    });
  });

  it("keeps the preview for the owner: a steward can't open the offer", () => {
    const action = listingAction("verify", ASSET, COMMUNITY, "listed", {
      owner: false,
    });
    expect(action.primary).toBe(true);
    expect(action.secondary).toBeUndefined();
  });

  it("names the step after a rejection or a revocation", () => {
    expect(
      listingAction("verify", ASSET, COMMUNITY, "listed", {
        verification: { level: "rejected", decision: "rejected" },
      }).label,
    ).toBe("Submit new documents");
    const revoked = listingAction("verify", ASSET, COMMUNITY, "suspended", {
      verification: { level: "revoked", decision: "revoked" },
    });
    expect(revoked).toMatchObject({ label: "Verify again", href: verify });
    // A suspended listing has no offer to preview.
    expect(revoked.secondary).toBeUndefined();
    // Revoked, then a newer submission rejected: the rejection is what to answer.
    expect(
      listingAction("verify", ASSET, COMMUNITY, "suspended", {
        verification: { level: "revoked", decision: "rejected" },
      }).label,
    ).toBe("Submit new documents");
  });

  it("shows a submission in review as a status, not a call to action", () => {
    expect(
      listingAction("verification_in_review", ASSET, COMMUNITY, "listed"),
    ).toMatchObject({
      label: "See your submission",
      primary: false,
      href: verify,
    });
  });

  it("offers a non-member nothing to do", () => {
    expect(
      listingAction("awaiting_verification", ASSET, COMMUNITY, "listed"),
    ).toEqual({
      label: "Waiting for verification",
      href: null,
      primary: false,
    });
  });

  it("says no IPO, dividends or treasury on steward surfaces", () => {
    const labels = (
      [
        "verify",
        "verification_in_review",
        "awaiting_verification",
        "launch_ipo",
        "awaiting_ipo",
      ] as const
    ).map((a) => listingAction(a, ASSET, COMMUNITY, "listed").label);
    expect(labels.join(" ")).not.toMatch(/IPO|dividend|treasury/i);
  });
});

function verificationOf(
  overrides: Partial<ListingVerification> = {},
): ListingVerification {
  return {
    level: "unverified",
    in_review: false,
    required: true,
    decision: null,
    decided_at: null,
    reason: null,
    run_id: null,
    ...overrides,
  };
}

describe("verificationChip", () => {
  it.each([
    [{ level: "unverified", in_review: false }, "Not verified"],
    [{ level: "documents_submitted", in_review: true }, "In review"],
    [{ level: "verified", in_review: false }, "Verified land"],
    [{ level: "rejected", in_review: false }, "Not approved"],
    [{ level: "revoked", in_review: false }, "Verification revoked"],
    [
      { level: "revoked", in_review: true },
      "Revoked · new documents in review",
    ],
  ] as const)("%o → %s", (verification, chip) => {
    expect(verificationChip(verification)).toBe(chip);
  });
});

describe("openingChecklist", () => {
  const base = {
    assetId: ASSET,
    communityId: COMMUNITY,
    rating: "Grade AA · 85.1 · Very strong health",
  };
  const verify = `/steward/list?community=${COMMUNITY}&asset=${ASSET}&step=prove`;
  const states = (steps: ReturnType<typeof openingChecklist>) =>
    steps.map((s) => `${s.id}:${s.state}:${s.status}`);
  const SANDBOX = /sandbox/i;
  const text = (steps: ReturnType<typeof openingChecklist>) =>
    steps.map((s) => `${s.status} ${s.detail}`).join(" ");

  it("puts verification first while the live offer waits for it", () => {
    const steps = openingChecklist({
      ...base,
      verification: verificationOf(),
      launchable: false,
      blockedReason: "not_verified",
    });
    expect(states(steps)).toEqual([
      "rated:done:Done",
      "verified:current:Needed",
      "open:upcoming:After verification",
    ]);
    expect(steps[0]!.detail).toBe("Grade AA · 85.1 · Very strong health");
    expect(steps[1]!.action).toEqual({
      label: "Verify this listing",
      href: verify,
    });
    expect(text(steps)).not.toMatch(SANDBOX);
  });

  it("is neutral until the preview answers: never says sandbox", () => {
    const steps = openingChecklist({ ...base, verification: undefined });
    expect(states(steps)).toEqual([
      "rated:done:Done",
      "verified:pending:Checking…",
      "open:pending:Checking…",
    ]);
    expect(text(steps)).not.toMatch(SANDBOX);
  });

  it("never says sandbox when the preview failed", () => {
    const steps = openingChecklist({ ...base, verification: null });
    expect(states(steps)[1]).toBe("verified:upcoming:Not checked");
    expect(text(steps)).not.toMatch(SANDBOX);
  });

  it("trusts the gate's blocked reason over a verification that says otherwise", () => {
    const steps = openingChecklist({
      ...base,
      verification: verificationOf({ required: false }),
      launchable: false,
      blockedReason: "not_verified",
    });
    expect(states(steps).slice(1)).toEqual([
      "verified:current:Needed",
      "open:upcoming:After verification",
    ]);
    expect(text(steps)).not.toMatch(SANDBOX);
  });

  it("never shows Ready while verification is required", () => {
    const steps = openingChecklist({
      ...base,
      verification: verificationOf({ level: "verified", required: true }),
      launchable: true,
    });
    expect(states(steps)[2]).toBe("open:upcoming:After verification");
  });

  it("waits while a reviewer checks the documents", () => {
    const steps = openingChecklist({
      ...base,
      verification: verificationOf({
        level: "documents_submitted",
        in_review: true,
      }),
      launchable: false,
      blockedReason: "not_verified",
    });
    expect(states(steps)[1]).toBe("verified:waiting:In review");
    expect(steps[1]!.action?.label).toBe("See your submission");
  });

  it("quotes a rejection's or a revocation's reason", () => {
    const rejected = openingChecklist({
      ...base,
      verification: verificationOf({
        level: "rejected",
        decision: "rejected",
        reason: "Unsigned minutes.",
      }),
    });
    expect(rejected[1]).toMatchObject({
      state: "current",
      status: "Not approved",
      detail: expect.stringContaining("Reason: “Unsigned minutes.”"),
      action: { label: "Submit new documents" },
    });
    const revoked = openingChecklist({
      ...base,
      verification: verificationOf({
        level: "revoked",
        decision: "revoked",
        reason: "Disputed title.",
      }),
    });
    expect(revoked[1]).toMatchObject({
      status: "Revoked",
      action: { label: "Verify again" },
    });
  });

  it("marks a verified listing done and the launch ready", () => {
    const steps = openingChecklist({
      ...base,
      verification: verificationOf({
        level: "verified",
        decision: "verified",
        required: false,
        decided_at: "2026-10-20T15:00:00Z",
      }),
      launchable: true,
    });
    expect(states(steps)).toEqual([
      "rated:done:Done",
      "verified:done:Done",
      "open:current:Ready",
    ]);
    expect(steps[1]!.detail).toMatch(/on 20 Oct 2026/);
  });

  it("calls verification optional only when the gate says it isn't required", () => {
    const steps = openingChecklist({
      ...base,
      verification: verificationOf({ required: false }),
      launchable: true,
    });
    expect(steps[1]).toMatchObject({
      state: "optional",
      detail: expect.stringMatching(SANDBOX),
      action: { label: "Verify anyway", href: verify },
    });
    const inReview = openingChecklist({
      ...base,
      verification: verificationOf({
        level: "documents_submitted",
        in_review: true,
        required: false,
      }),
      launchable: true,
    });
    expect(states(inReview).slice(1)).toEqual([
      "verified:optional:In review",
      "open:current:Ready",
    ]);
  });

  it("names another blocker without blaming verification", () => {
    expect(
      states(
        openingChecklist({
          ...base,
          verification: verificationOf({ required: false }),
          launchable: false,
          blockedReason: "run_in_progress",
        }),
      ),
    ).toEqual([
      "rated:done:Done",
      "verified:optional:Optional here",
      "open:upcoming:Not yet",
    ]);
  });
});

describe("listingAction for suspended listings", () => {
  it("opens the Exchange once the listing has traded", () => {
    expect(
      listingAction("view_on_exchange", ASSET, COMMUNITY, "suspended"),
    ).toMatchObject({ label: "View on Marketplace", href: `/asset/${ASSET}` });
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
