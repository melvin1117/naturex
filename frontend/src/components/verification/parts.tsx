import {
  CircleCheck,
  CircleX,
  FileClock,
  ShieldCheck,
  ShieldQuestionMark,
  ShieldX,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import type {
  CheckResult,
  VerificationCheck,
  VerificationLevel,
} from "@/lib/api/types";
import { CHECK_NOTE, checkLabel, RESULT_LABEL } from "@/lib/verification";

const LEVEL_ICON = {
  verified: ShieldCheck,
  revoked: ShieldX,
  documents_submitted: FileClock,
  rejected: ShieldQuestionMark,
  unverified: ShieldQuestionMark,
} satisfies Record<VerificationLevel, unknown>;

const LEVEL_TONE: Record<VerificationLevel, string> = {
  verified: "bg-lime/35 text-lime-ink",
  revoked: "bg-clay/15 text-clay-ink",
  documents_submitted: "bg-secondary text-secondary-foreground",
  rejected: "bg-secondary text-secondary-foreground",
  unverified: "bg-secondary text-secondary-foreground",
};

/**
 * A verification chip. `children` is the API's exact badge text; the
 * level only picks the icon and tone, so the words never depend on colour.
 */
export function VerificationBadge({
  level,
  children,
  tone = "light",
  className,
}: {
  level: VerificationLevel;
  children: string;
  tone?: "light" | "image";
  className?: string;
}) {
  const Icon = LEVEL_ICON[level];
  return (
    <Badge
      variant="secondary"
      data-level={level}
      className={cn(
        "max-w-full px-2.5 py-1 text-left leading-snug whitespace-normal [&>svg]:size-3.5",
        tone === "image" ? "bg-white/15 text-white" : LEVEL_TONE[level],
        className,
      )}
    >
      <Icon aria-hidden="true" />
      <span>{children}</span>
    </Badge>
  );
}

const RESULT_ICON = {
  pass: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
} satisfies Record<CheckResult, unknown>;

const RESULT_TONE: Record<CheckResult, string> = {
  pass: "text-lime-ink",
  warn: "text-clay-ink",
  fail: "text-destructive",
};

/** A check's result: icon and word, never colour alone. */
export function CheckResultLabel({ result }: { result: CheckResult }) {
  const Icon = RESULT_ICON[result];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-sm font-medium",
        RESULT_TONE[result],
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {RESULT_LABEL[result]}
    </span>
  );
}

type ChecklistItem = Pick<VerificationCheck, "check" | "result"> &
  Partial<Pick<VerificationCheck, "found" | "source">>;

/**
 * The deterministic checklist. `detailed` adds the value found and its source (steward and
 * reviewer only); the public panel shows names and results.
 */
export function Checklist({
  items,
  detailed = false,
  label = "Automated checks",
}: {
  items: readonly ChecklistItem[];
  detailed?: boolean;
  label?: string;
}) {
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {items.map((item) => (
        <li key={item.check} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <span className="min-w-0 font-medium">
              {checkLabel(item.check)}
            </span>
            <CheckResultLabel result={item.result} />
          </div>
          {detailed && item.found && (
            <p className="mt-1 text-sm break-words">
              <span className="text-muted-foreground">Found: </span>
              {item.found}
            </p>
          )}
          {detailed && item.source && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              How: {item.source}
            </p>
          )}
          {CHECK_NOTE[item.check] && (
            <p className="mt-1 text-xs text-muted-foreground">
              {CHECK_NOTE[item.check]}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
