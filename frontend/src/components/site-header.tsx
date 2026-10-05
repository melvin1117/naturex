import Link from "next/link";

import { Button } from "@/components/ui/button";

export const NAV_LINKS = [
  { href: "/", label: "Marketplace" },
  { href: "/list", label: "List land" },
  { href: "/portfolio", label: "Portfolio" },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          NatureX
        </Link>
        <nav aria-label="Main">
          <ul className="flex items-center gap-1">
            {NAV_LINKS.map(({ href, label }) => (
              <li key={href}>
                <Button asChild variant="ghost" size="sm">
                  <Link href={href}>{label}</Link>
                </Button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
