"use client";

import { cn } from "cn";

import Link from "@/components/app-link";
import { Lockup } from "@/components/brand";
import { AlertsBell } from "@/components/shell/alerts-bell";
import { PersonaMenu } from "@/components/shell/persona-menu";
import { TimeMachineSheet } from "@/components/shell/time-machine-sheet";
import { useWorld } from "@/lib/hooks";
import { usePathname } from "@/lib/nav";
import {
  isNavActive,
  SANDBOX_NAV,
  type SandboxNavItem,
} from "@/lib/sandbox-nav";
import { isSwitchable } from "@/lib/sandbox-personas";

/**
 * The sandbox's one bar: WildWorth, the three pages everyone has (the Reviewer swaps two for
 * Reviews), then the Time Machine, alerts and who you are. Below `md` the pages wrap onto
 * their own row.
 */
export function SandboxHeader() {
  const { world } = useWorld();
  const pathname = usePathname();
  const persona = world?.me?.persona;
  // Sandboxes start as Arjun and switch only between the three; an older session's other
  // persona (Mia) is a supporter too, so it gets Arjun's bar.
  const key = isSwitchable(persona) ? persona : "arjun";
  const items = SANDBOX_NAV[key];
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 px-4 sm:px-6 lg:gap-x-8">
        <Link
          href="/"
          className="flex h-16 shrink-0 items-center rounded-md"
          aria-label="WildWorth, Marketplace"
        >
          <Lockup size={22} />
        </Link>
        {/* Phones: the pages wrap onto their own row under the bar. */}
        <SandboxNav
          items={items}
          pathname={pathname}
          className="order-last -mx-1 w-[calc(100%+0.5rem)] border-t border-border/60 py-2 md:order-none md:mx-0 md:w-auto md:border-0 md:py-0"
        />
        <div className="ml-auto flex h-16 items-center gap-1 sm:gap-2">
          <TimeMachineSheet />
          <AlertsBell />
          <PersonaMenu persona={key} />
        </div>
      </div>
    </header>
  );
}

function SandboxNav({
  items,
  pathname,
  className,
}: {
  items: SandboxNavItem[];
  pathname: string;
  className?: string;
}) {
  return (
    <nav aria-label="Pages" className={className}>
      <ul className="flex items-center gap-1 overflow-x-auto">
        {items.map((item) => {
          const active = isNavActive(pathname, item);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center rounded-full px-4 text-sm font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-card text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
