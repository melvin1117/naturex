import { TriangleAlert } from "lucide-react";
import { useId } from "react";

import {
  Comparisons,
  DocumentReadings,
  UntrustedText,
} from "@/components/verification/ai-suggestion-fields";
import type { AiSuggestion } from "@/lib/api/types";
import { flagText, SUGGESTION_TEXT, suggestionTime } from "@/lib/ai-suggestion";

/** A completed suggestion: what it suggests and why, its warnings, then its evidence. */
export function AiSuggestionResult({
  suggestion,
}: {
  suggestion: AiSuggestion;
}) {
  const summary = SUGGESTION_TEXT[suggestion.suggestion ?? "unreadable"];
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-secondary/60 p-4">
        <p className="text-xs font-medium text-muted-foreground">
          The AI suggests (not a check result, not a decision)
        </p>
        <p className="mt-1 font-serif text-2xl leading-tight">
          {summary.label}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{summary.body}</p>
      </div>

      <Part title="Why">
        {suggestion.reasons.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {suggestion.reasons.map((reason, i) => (
              <li key={i}>
                <UntrustedText text={reason} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No reason given.</p>
        )}
      </Part>

      {suggestion.flags.length > 0 && (
        <Part title="Warnings">
          <ul aria-label="Warnings" className="space-y-2 text-sm">
            {suggestion.flags.map((flag) => (
              <li key={flag} className="flex items-start gap-2">
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-clay-ink"
                  aria-hidden="true"
                />
                <span>{flagText(flag)}</span>
              </li>
            ))}
          </ul>
        </Part>
      )}

      <Part title="Field by field">
        <Comparisons
          comparisons={suggestion.comparisons}
          documents={suggestion.documents}
        />
      </Part>

      <Part title="What was read from each document">
        <DocumentReadings documents={suggestion.documents} />
      </Part>

      <Provenance suggestion={suggestion} />
    </div>
  );
}

function Part({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="mb-2 text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Provenance({ suggestion }: { suggestion: AiSuggestion }) {
  return (
    <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-[auto_minmax(0,1fr)]">
      <dt>Models</dt>
      <dd translate="no" className="font-mono break-all">
        {suggestion.models.length > 0 ? suggestion.models.join(", ") : "None"}
      </dd>
      <dt>Method</dt>
      <dd translate="no" className="font-mono break-all">
        {suggestion.method_version}
      </dd>
      <dt>Made</dt>
      <dd className="tabular">{suggestionTime(suggestion.created_at)}</dd>
    </dl>
  );
}
