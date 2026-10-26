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
    <dl className={cn("flex flex-wrap gap-x-8 gap-y-4", className)}>
      {children}
    </dl>
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
    <div className="flex items-center gap-3">
      {/* An icon tile is a rounded square (DESIGN.md, Shapes). */}
      <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-card text-foreground shadow-soft">
        <Icon size={22} aria-hidden="true" />
      </span>
      {/* The label comes first for assistive tech; the number reads first on screen. */}
      <div className="flex flex-col-reverse">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd className="tabular text-2xl leading-tight font-light tracking-[-0.03em]">
          {value}
        </dd>
      </div>
    </div>
  );
}
