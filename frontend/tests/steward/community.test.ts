import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import type { ListingSummary, ListingVerification } from "@/lib/api/types";
import {
  communityBody,
  communityFailure,
  decisionNotice,
  listingAction,
  listingStatusLine,
  memberFailure,
  openingChecklist,
  sharePct,
  unseenNotices,
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
      "verify",
      "Verify this listing",
      `/steward/assets/${ASSET}/verify?community=${COMMUNITY}`,
    ],
    [
      "verification_in_review",
      "Documents in review",
      `/steward/assets/${ASSET}/verify?community=${COMMUNITY}`,
    ],
    [
      "launch_ipo",
      "Open to supporters",
      `/steward/assets/${ASSET}/ipo?community=${COMMUNITY}`,
    ],
    ["awaiting_ipo", "Waiting for the owner to open it to supporters", null],
    ["view_on_exchange", "View on Exchange", `/asset/${ASSET}`],
    ["none", "Closed", null],
  ] as const)("%s → %s", (action, label, href) => {
    expect(listingAction(action, ASSET, COMMUNITY)).toMatchObject({
      label,
      href,
    });
  });
});

describe("listingAction never points at a locked door (#216)", () => {
  const ipo = `/steward/assets/${ASSET}/ipo?community=${COMMUNITY}`;
  const verify = `/steward/assets/${ASSET}/verify?community=${COMMUNITY}`;

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
        verification: "rejected",
      }).label,
    ).toBe("Submit new documents");
    const revoked = listingAction("verify", ASSET, COMMUNITY, "suspended", {
      verification: "revoked",
    });
    expect(revoked).toMatchObject({ label: "Verify again", href: verify });
    // A suspended listing has no offer to preview.
    expect(revoked.secondary).toBeUndefined();
  });

  it("shows a submission in review as a status, not a call to action", () => {
    expect(
      listingAction("verification_in_review", ASSET, COMMUNITY, "listed"),
    ).toMatchObject({ primary: false, href: verify });
  });

  it("says no IPO, dividends or treasury on steward surfaces", () => {
    const labels = (
      [
        "verify",
        "verification_in_review",
        "launch_ipo",
        "awaiting_ipo",
      ] as const
    ).map((a) => listingAction(a, ASSET, COMMUNITY, "listed").label);
    expect(labels.join(" ")).not.toMatch(/IPO|dividend|treasury/i);
  });
});

function summaryListing(
  overrides: Partial<ListingSummary> = {},
  verification: Partial<ListingVerification> = {},
): ListingSummary {
  return {
    asset: {
      id: ASSET,
      name: "Laguna Viva",
      status: "listed",
      trading: false,
      area_ha: "225.00",
      grade: "AA",
      health_score: "85.10",
      sparkline: [],
      mock: true,
    } as ListingSummary["asset"],
    next_action: "verify",
    ipo_at: null,
    wallet: {
      balance: "0.00",
      ipo_proceeds: "0.00",
      community_fund_payouts: "0.00",
      retained_dividends: "0.00",
      total_received: "0.00",
    },
    holders: { count: 0, shares_held: 0, top: [] },
    shares: null,
    recommendations: [],
    report_version: 1,
    ...overrides,
    verification: {
      level: "unverified",
      required: true,
      decided_at: null,
      reason: null,
      run_id: null,
      ...verification,
    },
  };
}

describe("listingStatusLine", () => {
  it.each([
    [
      "verify",
      "unverified",
      "listed",
      "Rated and listed. Verify the land documents to open it to supporters.",
    ],
    [
      "verify",
      "rejected",
      "listed",
      "Documents not approved. Submit new ones to open it to supporters.",
    ],
    [
      "verify",
      "revoked",
      "suspended",
      "Verification revoked. Trading is paused until new documents are approved.",
    ],
    [
      "verification_in_review",
      "documents_submitted",
      "listed",
      "A NatureX reviewer is checking your land documents.",
    ],
    [
      "launch_ipo",
      "verified",
      "listed",
      "Verified. Open it to supporters when you're ready.",
    ],
    [
      "launch_ipo",
      "unverified",
      "listed",
      "Rated and listed. Open it to supporters when you're ready.",
    ],
    [
      "awaiting_ipo",
      "verified",
      "listed",
      "Rated and listed. The owner opens it to supporters.",
    ],
    ["continue_listing", "unverified", "draft", "Draft"],
  ] as const)("%s (%s, %s)", (action, level, status, line) => {
    const listing = summaryListing({ next_action: action }, { level });
    expect(listingStatusLine(listing, status, false)).toBe(line);
  });

  it("says a trading listing is open to supporters", () => {
    expect(
      listingStatusLine(
        summaryListing({ next_action: "view_on_exchange" }),
        "listed",
        true,
      ),
    ).toBe("Open to supporters");
  });
});

describe("decisionNotice", () => {
  const DECIDED = "2026-10-20T15:00:00Z";

  it("is null until a reviewer decided", () => {
    expect(decisionNotice(summaryListing(), COMMUNITY)).toBeNull();
    expect(
      decisionNotice(
        summaryListing(
          { next_action: "verification_in_review" },
          { level: "documents_submitted", run_id: "r1" },
        ),
        COMMUNITY,
      ),
    ).toBeNull();
  });

  it("celebrates an approval and leads the owner to open the offer", () => {
    const notice = decisionNotice(
      summaryListing(
        { next_action: "launch_ipo" },
        {
          level: "verified",
          required: false,
          decided_at: DECIDED,
          reason: "Matches the map.",
          run_id: "r1",
        },
      ),
      COMMUNITY,
    );
    expect(notice).toMatchObject({
      level: "verified",
      title: "Laguna Viva is verified",
      body: "A NatureX reviewer approved your land documents on 20 Oct 2026. You can open it to supporters now.",
      reason: "Matches the map.",
      action: {
        label: "Open to supporters",
        href: `/steward/assets/${ASSET}/ipo?community=${COMMUNITY}`,
      },
    });
    expect(notice!.key).toBe(`r1:verified:${DECIDED}`);
  });

  it("has no action for a steward waiting for the owner", () => {
    const notice = decisionNotice(
      summaryListing(
        { next_action: "awaiting_ipo" },
        { level: "verified", required: false, decided_at: DECIDED },
      ),
      COMMUNITY,
      { owner: false },
    );
    expect(notice?.action).toBeNull();
    expect(notice?.body).not.toMatch(/open it to supporters/);
  });

  it("gives a rejection's reason and the way to submit again", () => {
    expect(
      decisionNotice(
        summaryListing(
          {},
          {
            level: "rejected",
            decided_at: DECIDED,
            reason: "The minutes aren't signed.",
          },
        ),
        COMMUNITY,
      ),
    ).toMatchObject({
      title: "Laguna Viva: documents not approved",
      reason: "The minutes aren't signed.",
      action: {
        label: "Submit new documents",
        href: `/steward/assets/${ASSET}/verify?community=${COMMUNITY}`,
      },
    });
  });

  it("says a revocation pauses trading", () => {
    const listing = summaryListing(
      {
        asset: {
          ...summaryListing().asset,
          status: "suspended",
        },
      },
      { level: "revoked", decided_at: DECIDED, reason: "Disputed title." },
    );
    expect(decisionNotice(listing, COMMUNITY)).toMatchObject({
      title: "Laguna Viva: verification revoked",
      body: expect.stringMatching(/Trading is paused/),
      action: { label: "Verify again" },
    });
  });

  it("comes back for the next decision once dismissed", () => {
    const first = decisionNotice(
      summaryListing(
        {},
        { level: "rejected", decided_at: DECIDED, run_id: "a" },
      ),
      COMMUNITY,
    );
    const next = decisionNotice(
      summaryListing(
        { next_action: "launch_ipo" },
        { level: "verified", decided_at: DECIDED, run_id: "b" },
      ),
      COMMUNITY,
    );
    expect(unseenNotices([first], { [ASSET]: first!.key })).toEqual([]);
    expect(unseenNotices([next, null], { [ASSET]: first!.key })).toEqual([
      next,
    ]);
  });
});

describe("openingChecklist", () => {
  const base = {
    assetId: ASSET,
    communityId: COMMUNITY,
    rating: "Grade AA · 85.1 · Very strong health",
  };
  const verify = `/steward/assets/${ASSET}/verify?community=${COMMUNITY}`;
  const states = (steps: ReturnType<typeof openingChecklist>) =>
    steps.map((s) => `${s.id}:${s.state}:${s.status}`);

  it("puts verification first while the live offer waits for it", () => {
    const steps = openingChecklist({
      ...base,
      verification: summaryListing().verification,
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
  });

  it("waits while a reviewer checks the documents", () => {
    const steps = openingChecklist({
      ...base,
      verification: summaryListing({}, { level: "documents_submitted" })
        .verification,
    });
    expect(states(steps)[1]).toBe("verified:waiting:In review");
    expect(steps[1]!.action?.label).toBe("See your submission");
  });

  it("quotes a rejection's or a revocation's reason", () => {
    const rejected = openingChecklist({
      ...base,
      verification: summaryListing(
        {},
        { level: "rejected", reason: "Unsigned minutes." },
      ).verification,
    });
    expect(rejected[1]).toMatchObject({
      state: "current",
      status: "Not approved",
      detail: expect.stringContaining("Reason: “Unsigned minutes.”"),
      action: { label: "Submit new documents" },
    });
    const revoked = openingChecklist({
      ...base,
      verification: summaryListing(
        {},
        { level: "revoked", reason: "Disputed title." },
      ).verification,
    });
    expect(revoked[1]).toMatchObject({
      status: "Revoked",
      action: { label: "Verify again" },
    });
  });

  it("marks a verified listing done and the launch ready", () => {
    const steps = openingChecklist({
      ...base,
      verification: summaryListing(
        { next_action: "launch_ipo" },
        {
          level: "verified",
          required: false,
          decided_at: "2026-10-20T15:00:00Z",
        },
      ).verification,
      launchable: true,
    });
    expect(states(steps)).toEqual([
      "rated:done:Done",
      "verified:done:Done",
      "open:current:Ready",
    ]);
    expect(steps[1]!.detail).toMatch(/on 20 Oct 2026/);
  });

  it("calls verification optional where the world doesn't need it", () => {
    const steps = openingChecklist({
      ...base,
      verification: summaryListing({}, { required: false }).verification,
      launchable: true,
    });
    expect(steps[1]).toMatchObject({
      state: "optional",
      action: { label: "Verify anyway", href: verify },
    });
  });

  it("reads the preview's blocked reason without the summary", () => {
    expect(
      states(
        openingChecklist({
          ...base,
          communityId: null,
          verification: null,
          launchable: false,
          blockedReason: "not_verified",
        }),
      )[1],
    ).toBe("verified:current:Needed");
    expect(
      states(
        openingChecklist({
          ...base,
          verification: null,
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
