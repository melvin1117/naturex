import { ACTOR, type StoryLine } from "@/lib/trace-view";

import { ActorIcon } from "./actor";

/** The run in plain words: who did what, one line each, on a rail (the 30-second read). */
export function TraceStory({
  lines,
  compact = false,
}: {
  lines: StoryLine[];
  compact?: boolean;
}) {
  return (
    <ol className="relative space-y-4" aria-label="What happened in this run">
      <span
        aria-hidden="true"
        className="absolute top-3 bottom-3 left-3.5 w-px bg-machine-line"
      />
      {lines.map((line) => (
        <li key={line.key} className="relative flex gap-3">
          <ActorIcon actor={line.actor} className="relative z-10" />
          <div className="min-w-0 pt-0.5">
            <p className="text-[11px] font-medium text-machine-muted">
              {ACTOR[line.actor].name}
            </p>
            <p className="mt-0.5 text-sm leading-relaxed text-machine-ink">
              {line.text}
            </p>
            {!compact && line.details.length > 0 && (
              <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-machine-muted">
                {line.details.map((d) => (
                  <li key={d} className="break-words">
                    {d}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
