import type { DemoPersona } from "@/lib/api/types";

/**
 * Who a visitor can be in their sandbox (no sign-up), switched from the header. Everyone sees
 * the same app (Marketplace, Communities, Your stakes); only what's theirs differs: Rosa's
 * cooperative keeps a wetland, Arjun backs sites, and the Reviewer approves new listings.
 * Seeded in every sandbox (backend `seed.PERSONAS`).
 */
export const SANDBOX_PERSONAS: Record<
  Exclude<DemoPersona, "mia">,
  { name: string; role: string; blurb: string; home: string }
> = {
  rosa: {
    name: "Rosa",
    role: "Community",
    blurb: "Keeps a wetland near Mexico City",
    home: "/steward",
  },
  arjun: {
    name: "Arjun",
    role: "Supporter",
    blurb: "Backs living land",
    home: "/",
  },
  admin: {
    name: "Reviewer",
    role: "WildWorth team",
    blurb: "Approves new listings",
    home: "/admin/verifications",
  },
};

export type SwitchablePersona = keyof typeof SANDBOX_PERSONAS;

export const SWITCHABLE: SwitchablePersona[] = ["rosa", "arjun", "admin"];

export function personaLabel(key: SwitchablePersona): string {
  const p = SANDBOX_PERSONAS[key];
  return `${p.name} (${p.role})`;
}

export function isSwitchable(
  persona: DemoPersona | null | undefined,
): persona is SwitchablePersona {
  return SWITCHABLE.some((key) => key === persona);
}
