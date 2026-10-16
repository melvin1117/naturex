import { cn } from "cn";

/**
 * Dotted radial instrument for the health score: radial columns of dots, lit up to the score.
 * Each column is one point of health out of 100, so the reading is literal, not decorative.
 */
export function HealthRing({
  value,
  label = "Health",
  size = 168,
  tone = "light",
  className,
}: {
  value: number;
  label?: string;
  size?: number;
  tone?: "light" | "dark";
  className?: string;
}) {
  const columns = 100;
  const rings = 5;
  const cx = size / 2;
  const outer = size / 2 - 4;
  const inner = outer * 0.72;
  const lit = Math.round(value);
  const dots: { x: number; y: number; r: number; on: boolean; key: string }[] =
    [];
  for (let c = 0; c < columns; c++) {
    const angle = (c / columns) * Math.PI * 2 - Math.PI / 2;
    for (let r = 0; r < rings; r++) {
      const radius = inner + ((outer - inner) * r) / (rings - 1);
      // Thin the dots slightly on outer rings so the edge reads as a soft boundary.
      const skip = (c * 7 + r * 13) % 11 === 0 && r > 2;
      if (skip) continue;
      dots.push({
        // Rounded so server and client render identical attributes.
        x: Math.round((cx + Math.cos(angle) * radius) * 100) / 100,
        y: Math.round((cx + Math.sin(angle) * radius) * 100) / 100,
        r: Math.round((size / 210 + (r === 2 ? 0.25 : 0)) * 100) / 100,
        on: c < lit,
        key: `${c}-${r}`,
      });
    }
  }
  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label} ${value.toFixed(1)} out of 100`}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        aria-hidden="true"
      >
        {dots.map((d) => (
          <circle
            key={d.key}
            cx={d.x}
            cy={d.y}
            r={d.r}
            className={cn(
              d.on
                ? tone === "dark"
                  ? "fill-lime"
                  : "fill-primary"
                : tone === "dark"
                  ? "fill-machine-line"
                  : "fill-foreground/12",
            )}
          />
        ))}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div
            className={cn(
              "tabular font-light tracking-tight",
              tone === "dark" ? "text-machine-ink" : "text-foreground",
            )}
            style={{ fontSize: size * 0.24, lineHeight: 1 }}
          >
            {value.toFixed(1)}
          </div>
          <div
            className={cn(
              "mt-1 text-xs",
              tone === "dark" ? "text-machine-muted" : "text-muted-foreground",
            )}
          >
            {label} / 100
          </div>
        </div>
      </div>
    </div>
  );
}
