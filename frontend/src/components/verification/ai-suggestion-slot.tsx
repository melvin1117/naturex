import { Sparkles } from "lucide-react";

/**
 * Where the AI document check's suggestion goes (ADR-0006 §2, T71): an untrusted heuristic,
 * shown next to its source excerpts, that can't change a check or the decision. The API
 * doesn't return one yet, so this only says so; it never shows invented output.
 */
export function AiSuggestionSlot() {
  return (
    <section
      aria-labelledby="ai-suggestion-heading"
      className="rounded-3xl border border-dashed border-border p-6"
    >
      <h2
        id="ai-suggestion-heading"
        className="flex items-center gap-2 text-base font-semibold"
      >
        <Sparkles className="size-4" aria-hidden="true" />
        AI suggestion
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Not available for this review: the AI comparison of the documents with
        the listing isn&apos;t switched on. Decide from the documents, the
        checks and the map. When it is on, its suggestion appears here labelled
        as an untrusted heuristic, next to the excerpts it read; it never
        changes a check or the decision.
      </p>
    </section>
  );
}
