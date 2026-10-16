import { FileCheck2, FileClock, FileQuestion } from "lucide-react";
import { cn } from "cn";

import type { Verification } from "@/lib/prototype/world";

const TEXT: Record<Verification, { short: string; long: string }> = {
  verified: {
    short: "Documents reviewed",
    long: "Documents reviewed by NatureX (hackathon process)",
  },
  documents_submitted: {
    short: "Documents submitted",
    long: "Documents submitted, awaiting review",
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
