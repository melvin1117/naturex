import {
  Braces,
  Cpu,
  Eye,
  Globe,
  Lock,
  type LucideIcon,
  Search,
} from "lucide-react";
import { cn } from "cn";

import { ACTOR, type Actor } from "@/lib/trace-view";

const ICON: Record<Actor, LucideIcon> = {
  super: Cpu,
  nano: Cpu,
  ultra: Cpu,
  vision: Eye,
  embed: Search,
  tavily: Globe,
  code: Braces,
  ledger: Lock,
};

/** Fill per actor on the machine layer: Nemotron lime (stronger for bigger models), vision
 * lilac, the web sky, code and the ledger quiet. Always paired with a written name. */
export const ACTOR_FILL: Record<Actor, string> = {
  ultra: "bg-lime text-machine",
  super: "bg-lime/70 text-machine",
  nano: "bg-lime/45 text-machine",
  vision: "bg-lilac text-machine",
  embed: "bg-lilac/60 text-machine",
  tavily: "bg-sky text-machine",
  code: "bg-machine-line text-machine-ink",
  ledger: "bg-machine-ink/80 text-machine",
};

export function ActorIcon({
  actor,
  className,
}: {
  actor: Actor;
  className?: string;
}) {
  const Icon = ICON[actor];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full",
        ACTOR_FILL[actor],
        className,
      )}
    >
      <Icon className="size-3.5" strokeWidth={2} />
    </span>
  );
}

/** "Nemotron 3 Ultra · thinking": who did a step, written out (no logos). */
export function ActorChip({
  actor,
  name,
  note,
  className,
}: {
  actor: Actor;
  name?: string;
  note?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full bg-machine-raised py-0.5 pr-2.5 pl-0.5 text-xs text-machine-ink",
        className,
      )}
    >
      <ActorIcon actor={actor} className="size-5" />
      <span className="truncate font-medium">{name ?? ACTOR[actor].name}</span>
      {note && <span className="truncate text-machine-muted">· {note}</span>}
    </span>
  );
}
