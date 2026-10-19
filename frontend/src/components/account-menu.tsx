"use client";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initials, loginHref } from "@/lib/auth";
import { useSignOut, useWorld } from "@/lib/hooks";

/**
 * The signed-in account and "Sign out" (T61), or "Sign in" for anonymous visitors. Signing
 * out ends the server session (`POST /auth/logout`), then re-reads the world and resets the
 * cache; on a protected page the route guard then asks to sign in again.
 */
export function AccountMenu() {
  const pathname = usePathname();
  const { status, world } = useWorld();
  const signOut = useSignOut();
  const me = world?.me;

  // Until the world says who this is, show nothing rather than the wrong button.
  if (!me && status !== "ready" && status !== "error") return null;

  if (!me) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={loginHref(pathname)}>Sign in</Link>
      </Button>
    );
  }

  async function onSignOut() {
    try {
      await signOut.mutateAsync();
      toast("You're signed out");
    } catch (error) {
      toast.error("We couldn't sign you out", {
        description:
          error instanceof Error ? error.message : "Try again in a moment.",
      });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-48 gap-2 pl-1"
          aria-label={`Account: ${me.name}`}
        >
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
          >
            {initials(me.name)}
          </span>
          <span className="hidden truncate sm:inline">{me.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium">{me.name}</span>
          {me.email && (
            <span className="block truncate text-xs text-muted-foreground">
              {me.email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signOut.isPending}
          onSelect={() => void onSignOut()}
        >
          <LogOut aria-hidden="true" />
          {signOut.isPending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
