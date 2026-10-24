import { cn } from "cn";

function Skeleton({ className, style, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-accent motion-reduce:animate-none",
        className,
      )}
      // WildWorth pulses a little faster than Tailwind's 2 s (#216); still under reduced motion.
      style={{ animationDuration: "1.6s", ...style }}
      {...props}
    />
  );
}

export { Skeleton };
