"use client";

import { ArrowLeft, RefreshCwIcon } from "lucide-react";
import NextLink from "next/link";
import { useEffect, useRef, type ReactNode } from "react";

import { Bea } from "@/components/bea/bea";
import { Lockup } from "@/components/brand";
import { OutlineLoader } from "@/components/sandbox/outline-loader";
import { SandboxShell } from "@/components/shell/sandbox-shell";
import { MAIN_ID } from "@/components/shell/skip-link";
import { Button } from "@/components/ui/button";
import { toApiError } from "@/lib/api/errors";
import { useStartDemo, useWorld } from "@/lib/hooks";

/**
 * Everything under `/sandbox` runs in the visitor's own sandbox (a demo session in `ww_demo`),
 * with no sign-up: without one, it opens one straight away (as Arjun, the supporter) and
 * shows the page asked for. Then every page gets the sandbox's shell.
 */
export function SandboxGate({ children }: { children: ReactNode }) {
  const { status, world, error, retry } = useWorld();
  if (world?.me?.persona) return <SandboxShell>{children}</SandboxShell>;
  if (status === "idle" || status === "loading") return <Opening />;
  if (status === "error")
    return (
      <Problem
        title="We couldn't reach your sandbox"
        detail={error?.message ?? "Check your connection and try again."}
        retry={() => void retry()}
      />
    );
  return <AutoStart />;
}

function startError(code: string | null | undefined): string {
  if (code === "too_many_attempts")
    return "Too many sandboxes from this network this hour. Try again a little later.";
  if (code === "demo_busy")
    return "Every new sandbox for this hour is taken. Try again in a few minutes.";
  return "The service may be waking up; it takes about half a minute.";
}

/** No sandbox yet: open one once (StrictMode runs effects twice in development). */
function AutoStart() {
  const start = useStartDemo();
  const started = useRef(false);
  const { mutate } = start;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void mutate("arjun");
  }, [mutate]);
  if (start.error)
    return (
      <Problem
        title="Your sandbox didn't open"
        detail={startError(toApiError(start.error).code)}
        retry={() => void mutate("arjun")}
      />
    );
  return <Opening />;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main
      id={MAIN_ID}
      tabIndex={-1}
      className="grid flex-1 place-items-center bg-machine px-6 text-machine-ink outline-none"
    >
      <div className="flex max-w-md flex-col items-center text-center">
        {children}
      </div>
    </main>
  );
}

function Opening() {
  return (
    <Frame>
      <OutlineLoader />
      <p role="status" className="mt-8 font-serif text-3xl tracking-tight">
        Opening your sandbox…
      </p>
      <p className="mt-2 text-sm text-machine-muted">
        Your own copy of WildWorth. No sign-up.
      </p>
    </Frame>
  );
}

function Problem({
  title,
  detail,
  retry,
}: {
  title: string;
  detail: string;
  retry: () => void;
}) {
  return (
    <Frame>
      <Lockup size={22} reading="lime" />
      <Bea size={72} state="cant-answer" label="" className="mt-8" />
      <h1 className="mt-5 font-serif text-3xl tracking-tight">{title}</h1>
      <p role="alert" className="mt-2 text-machine-muted">
        {detail}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button variant="on-image" onClick={retry}>
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
        <Button asChild variant="on-image-outline">
          <NextLink href="/">
            <ArrowLeft aria-hidden="true" />
            Back to WildWorth
          </NextLink>
        </Button>
      </div>
    </Frame>
  );
}
