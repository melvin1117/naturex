import type { DemoPersona } from "@/lib/api/types";

/** Who a no-sign-up visitor can be in their sandbox, with what they do, so each is clear at a
 * glance ("Rosa (Community steward)"). Seeded in every sandbox (backend `seed.PERSONAS`). */
export const SANDBOX_PERSONAS: Record<
  Exclude<DemoPersona, "mia">,
  { name: string; role: string; home: string }
> = {
  rosa: { name: "Rosa", role: "Community steward", home: "/steward" },
  arjun: { name: "Arjun", role: "Supporter", home: "/" },
  admin: { name: "Admin", role: "WildWorth team", home: "/admin" },
};

export type SwitchablePersona = keyof typeof SANDBOX_PERSONAS;

export const SWITCHABLE: SwitchablePersona[] = ["rosa", "arjun", "admin"];

export function personaLabel(key: SwitchablePersona): string {
  const p = SANDBOX_PERSONAS[key];
  return `${p.name} (${p.role})`;
}
