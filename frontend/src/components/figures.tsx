import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * A page's key numbers as figures, not a sentence: each a brand icon tile, the number, then what
 * it counts. Use under a page's title (the Marketplace, a community).
 */
export function Figures({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-wrap gap-x-8 gap-y-4", className)}>
      {children}
    </ul>
  );
}

export function Figure({
  icon: Icon,
  value,
  label,
}: {
  icon: LucideIcon;
  value: ReactNode;
  label: string;
}) {
  return (
    <li className="flex items-center gap-3">
      {/* An icon tile is a rounded square (DESIGN.md, Shapes). */}
      <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-card text-foreground shadow-soft">
        <Icon size={22} aria-hidden="true" />
      </span>
      {/* Read as one phrase: "3 sites rated". */}
      <span className="flex flex-col">
        <span className="tabular text-2xl leading-tight font-light tracking-[-0.03em]">
          {value}
        </span>{" "}
        <span className="text-sm text-muted-foreground">{label}</span>
      </span>
    </li>
  );
}
