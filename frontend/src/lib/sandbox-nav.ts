import type { SwitchablePersona } from "@/lib/sandbox-personas";

/** One page in the sandbox's top bar. `href` is an app path; links add `/sandbox` (lib/nav). */
export interface SandboxNavItem {
  href: string;
  label: string;
  /** Also active on these app paths (a site's page belongs to the Marketplace). */
  alsoOn?: readonly string[];
}

const MARKETPLACE: SandboxNavItem = {
  href: "/",
  label: "Marketplace",
  alsoOn: ["/asset", "/trace"],
};

/** Everyone gets the same three pages; the Reviewer swaps Communities and stakes for reviews. */
export const SANDBOX_NAV: Record<SwitchablePersona, SandboxNavItem[]> = {
  rosa: [
    MARKETPLACE,
    { href: "/steward", label: "Communities" },
    { href: "/portfolio", label: "Your stakes" },
  ],
  arjun: [
    MARKETPLACE,
    { href: "/steward", label: "Communities" },
    { href: "/portfolio", label: "Your stakes" },
  ],
  admin: [MARKETPLACE, { href: "/admin/verifications", label: "Reviews" }],
};

/** Whether `item` is the page `pathname` (an app path) belongs to. */
export function isNavActive(pathname: string, item: SandboxNavItem): boolean {
  const under = (base: string) =>
    base === "/"
      ? pathname === "/"
      : pathname === base || pathname.startsWith(`${base}/`);
  return under(item.href) || (item.alsoOn ?? []).some(under);
}
