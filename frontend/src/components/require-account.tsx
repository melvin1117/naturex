"use client";

import { LockKeyhole, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { RouteSkeleton } from "@/components/page-skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  allowPrototypeDemo = false,
}: {
  children: ReactNode;
  /** Platform admins only (`me.is_admin`). */
  admin?: boolean;
  /**
   * Also open to an anonymous visitor in the scripted prototype demo (until T65). Only for
   * prototype screens with scripted data; never for `/admin`.
   */
  allowPrototypeDemo?: boolean;
}) {
  const router = useRouter();
  const { status, world, error, retry } = useWorld();
  const { demo, hydrated } = usePrototype();
  const access = protectedAccess({
    status,
    me: world?.me,
    admin,
    prototypeDemo: allowPrototypeDemo && demo,
    // Without the exception there's no prototype flag to wait for.
    prototypeReady: !allowPrototypeDemo || hydrated,
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
          {/* The page's only heading: the guarded screen (and its h1) isn't rendered. */}
          <AlertTitle>
            <h1>The control room is for platform admins</h1>
          </AlertTitle>
          <AlertDescription>
            <p>
              You&apos;re signed in as {world?.me?.name}, which doesn&apos;t
              have admin access. Admin accounts are created by an operator.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/">Go to the Marketplace</Link>
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
          <AlertTitle>
            <h1>We couldn&apos;t check your session</h1>
          </AlertTitle>
          <AlertDescription>
            <p>
              {error?.message ??
                "Can't reach NatureX. Check your connection and try again."}
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
    <RouteSkeleton
      label={
        access === "sign-in"
          ? "Taking you to sign in…"
          : "Checking your session…"
      }
    />
  );
}
