import { FileCheck2, FileClock, FileQuestion } from "lucide-react";
import { cn } from "cn";

/** How far a demo site's land documents got (the scripted levels ADR-0006 §6 badges). */
export type Verification = "verified" | "documents_submitted" | "unverified";

const TEXT: Record<Verification, { short: string; long: string }> = {
  // Every document in the prototype is a sample, so the ADR-0006 §6 demo badge applies.
  verified: {
    short: "Demo verification",
    long: "Demo verification: sample documents, no real ownership checked",
  },
  documents_submitted: {
    short: "Sample documents submitted",
    long: "Sample documents submitted, awaiting review (demo)",
  },
  unverified: {
    short: "Self-attested",
    long: "Self-attested by the community",
  },
};

export function VerificationBadge({
  level,
  tone = "light",
  compact = false,
  className,
}: {
  level: Verification;
  tone?: "light" | "image";
  compact?: boolean;
  className?: string;
}) {
  const Icon =
    level === "verified"
      ? FileCheck2
      : level === "documents_submitted"
        ? FileClock
        : FileQuestion;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tone === "image"
          ? "bg-white/15 text-white"
          : level === "verified"
            ? "bg-lime/30 text-lime-ink"
            : "bg-secondary text-muted-foreground",
        className,
      )}
      title={TEXT[level].long}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {compact ? TEXT[level].short : TEXT[level].long}
    </span>
  );
}
