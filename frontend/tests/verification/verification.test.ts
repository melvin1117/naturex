import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import {
  checkCounts,
  checkLabel,
  currentRun,
  decisionFailure,
  documentFacts,
  fileProblem,
  ledgerEntryHref,
  reviewerLabel,
  submitFailure,
  uploadFailure,
} from "@/lib/verification";

import { CHECKLIST, document, run } from "./fixtures";

describe("labels", () => {
  it("names checks, reviewer roles and documents", () => {
    expect(checkLabel("consent_document")).toBe(
      "Consent-labelled document attached",
    );
    expect(checkLabel("registry_match")).toBe("Registry match");
    expect(reviewerLabel("platform_admin")).toBe("WildWorth platform admin");
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
    expect(submitFailure(err(409, "submission_full"))).toMatch(/at most 3/);
    expect(decisionFailure(err(409, "stale_run"))).toMatch(
      /needs to submit again/,
    );
    expect(decisionFailure(err(403, "conflict_of_interest"))).toMatch(
      /another admin/,
    );
  });
});
