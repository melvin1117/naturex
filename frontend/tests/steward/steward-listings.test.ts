import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import { withdrawFailure } from "@/lib/steward-listings";

describe("withdrawFailure", () => {
  const err = (status: number, code: string) =>
    new ApiError(status, code, code, code);

  it("a listing that moved on refreshes the list", () => {
    const failure = withdrawFailure(err(409, "cannot_withdraw_listed"));
    expect(failure.message).toMatch(/listed now, so it can't be withdrawn/);
    expect(failure.stale).toBe(true);
  });

  it("a rating that started says to wait", () => {
    const failure = withdrawFailure(err(409, "run_in_progress"));
    expect(failure.title).toBe("A rating is running");
    expect(failure.stale).toBe(true);
  });

  it("anything else is the listing flow's message", () => {
    const failure = withdrawFailure(err(403, "members_only"));
    expect(failure.message).toMatch(/owner and stewards/);
    expect(failure.stale).toBe(false);
  });
});
