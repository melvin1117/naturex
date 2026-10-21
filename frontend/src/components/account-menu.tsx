"use client";

import { Copy, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { toast } from "sonner";

import { copyText } from "@/components/account-id";
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
import { usePrototype } from "@/lib/prototype/store";

/**
 * The signed-in account and "Sign out" (T61), or "Sign in" for anonymous visitors. Signing
 * out ends the server session (`POST /auth/logout`), then re-reads the world and resets the
 * cache; on a protected page the route guard then asks to sign in again.
 */
export function AccountMenu() {
  // useSearchParams needs a Suspense boundary on statically rendered pages; until the client
  // renders, the world isn't known anyway, so nothing shows.
  return (
    <Suspense fallback={null}>
      <AccountMenuContent />
    </Suspense>
  );
}

function AccountMenuContent() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { status, world } = useWorld();
  const { exitDemo } = usePrototype();
  const signOut = useSignOut();
  const me = world?.me;
  const signInLink = useRef<HTMLAnchorElement>(null);
  const focusSignIn = useRef(false);

  // The menu (and its trigger) is gone after sign-out: keep focus in the header.
  useEffect(() => {
    if (me || !focusSignIn.current) return;
    focusSignIn.current = false;
    signInLink.current?.focus();
  }, [me]);

  // Until the world says who this is, show nothing rather than the wrong button.
  if (!me && status !== "ready" && status !== "error") return null;

  if (!me) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link
          ref={signInLink}
          href={loginHref(search ? `${pathname}?${search}` : pathname)}
        >
          Sign in
        </Link>
      </Button>
    );
  }

  async function onSignOut() {
    // The scripted-demo exception belongs to anonymous visitors who chose it, not to whoever
    // uses this browser next.
    exitDemo();
    focusSignIn.current = true;
    try {
      await signOut.mutateAsync();
      toast("You're signed out");
    } catch (error) {
      focusSignIn.current = false;
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
          {/* Initials as generated content, so the button's visible text matches its name. */}
          <span
            aria-hidden="true"
            data-initials={initials(me.name)}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground before:content-[attr(data-initials)]"
          />
          <span className="hidden min-w-0 truncate sm:inline">{me.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 rounded-2xl p-1.5">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium">{me.name}</span>
          {me.email && (
            <span className="block truncate text-xs text-muted-foreground">
              {me.email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal">
          <span className="block text-xs text-muted-foreground">
            Account ID, to join a community as a steward
          </span>
          <code
            translate="no"
            className="mt-0.5 block truncate font-mono text-xs select-all"
          >
            {me.id}
          </code>
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() =>
            void copyText(me.id).then((ok) =>
              ok
                ? toast("Account ID copied")
                : toast.error("We couldn't copy your account ID", {
                    description: "Select it in the menu and copy it yourself.",
                  }),
            )
          }
        >
          <Copy aria-hidden="true" />
          Copy account ID
        </DropdownMenuItem>
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
