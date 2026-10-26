"use client";

import { LockKeyhole } from "lucide-react";
import Link from "@/components/app-link";
import type { ReactNode } from "react";

import { RouteSkeleton } from "@/components/page-skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useSwitchPersona, useWorld } from "@/lib/hooks";

/**
 * The Reviewer's pages (Reviews): anyone else in the sandbox sees whose page it is, with one
 * tap to become the Reviewer. The sandbox gate has opened a session before this renders. This
 * only decides what the page shows: the backend authorizes every request.
 */
export function ReviewerGate({ children }: { children: ReactNode }) {
  const me = useWorld().world?.me;
  if (!me) return <RouteSkeleton label="Opening your sandbox…" />;
  if (!me.is_admin) return <ReviewerOnly name={me.name} />;
  return children;
}

/** A sandbox page for the Reviewer, opened as someone else: one tap to become the Reviewer. */
function ReviewerOnly({ name }: { name: string }) {
  const switcher = useSwitchPersona();
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <Alert>
        <LockKeyhole aria-hidden="true" />
        {/* The page's only heading: the guarded screen (and its h1) isn't rendered. */}
        <AlertTitle>
          <h1>Only the Reviewer sees this page</h1>
        </AlertTitle>
        <AlertDescription>
          <p>
            You&apos;re {name} right now. Switch to the Reviewer to approve new
            listings.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={switcher.isPending}
              onClick={() => void switcher.mutate("admin")}
            >
              Switch to the Reviewer
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/">Go to the Marketplace</Link>
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
