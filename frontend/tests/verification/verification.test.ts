import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import {
  BADGE,
  checkCounts,
  checkLabel,
  currentRun,
  decisionFailure,
  documentFacts,
  fileProblem,
  ledgerEntryHref,
  reviewerLabel,
  runBadge,
  stewardStatus,
  submitFailure,
  uploadFailure,
} from "@/lib/verification";

import { CHECKLIST, document, run, verifiedRun } from "./fixtures";

describe("badge wording (ADR-0006 §4, §6)", () => {
  it("uses the exact strings, by evidence and never by deployment mode", () => {
    expect(BADGE).toEqual({
      reviewed: "Documents reviewed by NatureX (hackathon process)",
      sample: "Demo verification: sample documents, no real ownership checked",
      selfAttested: "Self-attested by the community",
      revoked: "Verification revoked",
    });
    expect(runBadge(null)).toBe("Self-attested by the community");
    expect(runBadge(run())).toBe("Self-attested by the community");
    expect(runBadge(verifiedRun())).toBe(
      "Documents reviewed by NatureX (hackathon process)",
    );
    // Real documents reviewed in a demo deployment keep the review wording.
    expect(runBadge(verifiedRun({ mode: "demo" }))).toBe(
      "Documents reviewed by NatureX (hackathon process)",
    );
    expect(runBadge(verifiedRun({ evidence_kind: "sample" }))).toBe(
      "Demo verification: sample documents, no real ownership checked",
    );
    expect(
      runBadge(run({ level: "revoked", effective_level: "revoked" })),
    ).toBe("Verification revoked");
    // A revocation stands even once the listing changed.
    expect(
      runBadge(run({ level: "revoked", effective_level: "unverified" })),
    ).toBe("Verification revoked");
    // A verified run whose listing changed counts as unverified.
    expect(runBadge(verifiedRun({ effective_level: "unverified" }))).toBe(
      "Self-attested by the community",
    );
    expect(Object.values(BADGE).join(" ")).not.toMatch(/ownership proven/i);
  });
});

describe("labels", () => {
  it("names checks, reviewer roles and documents", () => {
    expect(checkLabel("consent_document")).toBe(
      "Consent-labelled document attached",
    );
    expect(checkLabel("registry_match")).toBe("Registry match");
    expect(reviewerLabel("platform_admin")).toBe("NatureX platform admin");
    expect(reviewerLabel("demo_auto")).toBe("Demo auto");
    expect(reviewerLabel(null)).toBeNull();
    expect(documentFacts(document())).toBe("PDF · 3 pages · 1.2 MB");
    expect(
      documentFacts(
        document({
          media_type: "image/png",
          page_count: null,
          width: 1200,
          height: 800,
          size_bytes: 348_160,
        }),
      ),
    ).toBe("PNG · 1200 × 800 px · 340 KB");
  });

  it("counts results and finds the current run", () => {
    expect(
      checkCounts([...CHECKLIST, { ...CHECKLIST[0]!, result: "fail" }]),
    ).toEqual({ pass: 4, warn: 0, fail: 1 });
    expect(currentRun(undefined)).toBeNull();
    const older = run({ id: "x", is_current: false });
    expect(currentRun([run(), older])?.id).toBe(run().id);
    expect(currentRun([older])).toBeNull();
  });

  it("links to the ledger entry", () => {
    expect(ledgerEntryHref("abc", 7)).toBe(
      "/asset/abc?tab=ledger#ledger-entry-7",
    );
  });
});

describe("fileProblem", () => {
  it.each([
    [null, "Choose a file to upload."],
    [{ type: "image/gif", size: 10 }, "Choose a PDF, JPEG or PNG file."],
    [{ type: "application/pdf", size: 0 }, "That file is empty."],
    [
      { type: "application/pdf", size: 6 * 1024 * 1024 },
      "That file is 6.0 MB; the limit is 5 MB.",
    ],
    [{ type: "image/jpeg", size: 5 * 1024 * 1024 }, null],
  ])("%o → %s", (file, message) => {
    expect(fileProblem(file)).toBe(message);
  });
});

describe("stewardStatus", () => {
  it("explains each state", () => {
    expect(stewardStatus(null).title).toBe("Not verified yet");
    expect(stewardStatus(run()).title).toBe("Waiting for a reviewer");
    expect(stewardStatus(verifiedRun()).title).toBe(
      "Documents reviewed by NatureX (hackathon process)",
    );
    expect(
      stewardStatus(verifiedRun({ fingerprint_matches: false })).title,
    ).toBe("The listing changed since its last review");
    expect(stewardStatus(run({ level: "rejected" })).tone).toBe("negative");
    expect(stewardStatus(run({ level: "revoked" })).title).toBe(
      "Verification revoked",
    );
  });
});

describe("refusals in words", () => {
  const err = (status: number, code: string, retry: number | null = null) =>
    new ApiError(status, "fallback", code, code, retry);

  it("explains upload refusals", () => {
    expect(uploadFailure(err(422, "pdf_encrypted"))).toMatch(
      /password-protected/,
    );
    expect(uploadFailure(err(409, "document_reused"))).toMatch(
      /already backs another listing/,
    );
    expect(uploadFailure(err(429, "upload_rate_limited", 120))).toMatch(
      /Try again in 2 minutes/,
    );
    expect(uploadFailure(err(500, "boom"))).toBe("fallback");
  });

  it("explains submit and decision refusals", () => {
    expect(submitFailure(err(409, "document_already_submitted"))).toMatch(
      /already submitted/,
    );
    expect(decisionFailure(err(409, "stale_run"))).toMatch(
      /needs to submit again/,
    );
    expect(decisionFailure(err(403, "conflict_of_interest"))).toMatch(
      /another admin/,
    );
  });
});
