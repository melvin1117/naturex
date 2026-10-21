"use client";

import { RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";

/**
 * What an `error.tsx` boundary shows when a screen crashes: what happened in plain words, a
 * retry and a way out. Focus moves to the heading so a screen reader hears it. The error's
 * message isn't shown: it may hold internals. Next logs client errors to the browser console;
 * a server error reaches the client without its message, only an opaque `digest` that matches
 * the server log, shown here as a reference to quote.
 */
export function RouteError({
  reset,
  digest,
  home = { href: "/", label: "Back to the Marketplace" },
}: {
  reset: () => void;
  digest?: string;
  home?: { href: string; label: string };
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-24 text-center">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-serif text-5xl tracking-tight outline-none"
      >
        Something went wrong
      </h1>
      <p className="mt-3 text-muted-foreground">
        This screen hit an error and couldn&apos;t load. Try again; if it keeps
        happening, reload the page.
      </p>
      {digest && (
        <p className="mt-2 text-xs text-muted-foreground">
          Reference: <code translate="no">{digest}</code>
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button onClick={reset}>
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href={home.href}>{home.label}</Link>
        </Button>
      </div>
    </div>
  );
}
