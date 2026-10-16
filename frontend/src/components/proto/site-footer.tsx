import { DATA_ATTRIBUTIONS } from "@/lib/prototype/data";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border/70">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-8 text-xs text-muted-foreground sm:px-6 md:grid-cols-[1fr_2fr]">
        <div className="space-y-1.5">
          <p className="font-medium text-foreground">
            NatureX · hackathon prototype
          </p>
          <p>
            Sandbox with play money. Nothing here is a real security or
            investment. Values are screening estimates from published
            benefit-transfer coefficients, not certified appraisals.
          </p>
          <p>Verification: demo mode.</p>
        </div>
        <div>
          <p className="font-medium text-foreground">Data</p>
          <p className="mt-1.5 leading-relaxed">
            {DATA_ATTRIBUTIONS.join(" · ")}
          </p>
        </div>
      </div>
    </footer>
  );
}
