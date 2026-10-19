"use client";

import { LockKeyhole, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { loginHref, protectedAccess } from "@/lib/auth";
import { useWorld } from "@/lib/hooks";
import { usePrototype } from "@/lib/prototype/store";

function currentPath(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

/**
 * Protected routes (`/steward/*`, `/portfolio`, `/admin`; T61). A client guard on
 * `world.me`, the account the backend resolved from the HttpOnly session cookie: anonymous
 * visitors go to `/login?next=<this page>`; a signed-in account without access (a non-admin
 * on `/admin`) sees a 403 message instead of a redirect loop. This only decides what the page
 * shows: the backend authorizes every request.
 */
export function RequireAccount({
  children,
  admin = false,
}: {
  children: ReactNode;
  /** Platform admins only (`me.is_admin`). */
  admin?: boolean;
}) {
  const router = useRouter();
  const { status, world, retry } = useWorld();
  const { demo, hydrated } = usePrototype();
  const access = protectedAccess({
    status,
    me: world?.me,
    admin,
    prototypeDemo: demo,
    prototypeReady: hydrated,
  });

  useEffect(() => {
    if (access === "sign-in") router.replace(loginHref(currentPath()));
  }, [access, router]);

  if (access === "allowed") return children;

  if (access === "forbidden") {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <Alert>
          <LockKeyhole aria-hidden="true" />
          <AlertTitle>The control room is for platform admins</AlertTitle>
          <AlertDescription>
            <p>
              You&apos;re signed in as {world?.me?.name}, which doesn&apos;t
              have admin access. Admin accounts are created by an operator.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/">Go to the Exchange</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (access === "unavailable") {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>We couldn&apos;t check your session</AlertTitle>
          <AlertDescription>
            <p>
              Can&apos;t reach NatureX. Check your connection and try again.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void retry()}
            >
              <RefreshCwIcon aria-hidden="true" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
    >
      <Spinner aria-hidden="true" role="presentation" />
      {access === "sign-in"
        ? "Taking you to sign in…"
        : "Checking your session…"}
    </div>
  );
}
