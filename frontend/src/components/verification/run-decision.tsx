import { History } from "lucide-react";

import type { VerificationRun } from "@/lib/api/types";
import { date } from "@/lib/prototype/format";
import {
  DOC_TYPE_LABEL,
  LEVEL_LABEL,
  checkCounts,
  reviewerLabel,
} from "@/lib/verification";

/** Who decided a run (as a role), when, and the reviewer's words. */
export function RunDecision({ run }: { run: VerificationRun }) {
  const reviewer = reviewerLabel(run.reviewer_role);
  const rows: { label: string; value: string }[] = [
    { label: "Submitted", value: date(run.created_at) },
  ];
  if (run.decided_at)
    rows.push({ label: "Decided", value: date(run.decided_at) });
  if (reviewer) rows.push({ label: "Reviewed by", value: reviewer });
  if (run.revoked_at)
    rows.push({ label: "Revoked", value: date(run.revoked_at) });
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3 text-sm">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="tabular mt-0.5 font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
      {run.reason && (
        <blockquote className="rounded-2xl bg-secondary/60 p-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">
            {run.level === "rejected"
              ? "Reviewer's reason for rejecting"
              : "Reviewer's note"}
          </p>
          <p className="mt-1 whitespace-pre-line">{run.reason}</p>
        </blockquote>
      )}
      {run.revoke_reason && (
        <blockquote className="rounded-2xl bg-clay/10 p-3 text-sm">
          <p className="text-xs font-medium text-clay-ink">
            Reason for revoking
          </p>
          <p className="mt-1 whitespace-pre-line">{run.revoke_reason}</p>
        </blockquote>
      )}
    </div>
  );
}

/** Earlier runs of a listing, newest first; runs are write-once, so this is the full record. */
export function RunHistory({ runs }: { runs: readonly VerificationRun[] }) {
  if (runs.length === 0) return null;
  return (
    <ol className="space-y-3" aria-label="Earlier submissions">
      {runs.map((run) => {
        const counts = checkCounts(run.checklist);
        return (
          <li key={run.id} className="rounded-2xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <History
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="font-medium">{LEVEL_LABEL[run.level]}</span>
              <span className="text-muted-foreground">
                {date(run.created_at)}
              </span>
              <span className="text-xs text-muted-foreground">
                {counts.pass} passed · {counts.warn} warnings · {counts.fail}{" "}
                failed
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {run.documents.map((d) => DOC_TYPE_LABEL[d.doc_type]).join(", ")}
            </p>
            {(run.reason || run.revoke_reason) && (
              <div className="mt-3">
                <RunDecision run={run} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
