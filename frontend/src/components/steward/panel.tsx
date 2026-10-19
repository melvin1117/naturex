import { useId } from "react";
import { cn } from "cn";

/**
 * A Steward app card: the prototype's panel look, with an `h2` (these sit right under the
 * page's `h1`) that also names the region.
 */
export function StewardPanel({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn("rounded-3xl bg-card p-6 shadow-soft", className)}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
