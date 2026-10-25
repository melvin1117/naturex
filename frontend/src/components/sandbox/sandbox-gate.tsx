"use client";

import { ArrowLeft, ArrowRight, RefreshCwIcon } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { Lockup } from "@/components/brand";
import { RouteSkeleton } from "@/components/page-skeletons";
import {
  LOOK_AROUND,
  SandboxFlow,
  useOpenSandbox,
} from "@/components/sandbox/sandbox-flow";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useWorld } from "@/lib/hooks";

/**
 * Everything under `/sandbox` needs the visitor's own sandbox (a demo session in `ww_demo`).
 * Without one, this offers to open it instead of showing the live world or a sign-in.
 */
export function SandboxGate({ children }: { children: ReactNode }) {
  const { status, world, error, retry } = useWorld();
  if (world?.me?.persona) return children;
  if (status === "idle" || status === "loading")
    return <RouteSkeleton label="Opening your sandbox…" />;
  if (status === "error")
    return (
      <StartFrame>
        <h1 className="font-serif text-4xl tracking-tight">
          We couldn&apos;t reach your sandbox
        </h1>
        <p className="mt-3 text-machine-muted">
          {error?.message ?? "Check your connection and try again."}
        </p>
        <Button
          variant="on-image"
          className="mt-6"
          onClick={() => void retry()}
        >
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
      </StartFrame>
    );
  return <SandboxStart />;
}

function StartFrame({ children }: { children: ReactNode }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex-1 bg-machine text-machine-ink outline-none"
    >
      <div className="mx-auto max-w-2xl px-5 py-8 sm:py-14">
        <nav className="flex items-center justify-between gap-4 text-sm">
          <Lockup size={24} reading="lime" />
          <NextLink
            href="/"
            className="inline-flex items-center gap-1.5 text-machine-muted underline-offset-4 hover:text-machine-ink hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to WildWorth
          </NextLink>
        </nav>
        <div className="mt-12">{children}</div>
      </div>
    </main>
  );
}

function SandboxStart() {
  const sandbox = useOpenSandbox();
  const busy = sandbox.busy === LOOK_AROUND.key;
  return (
    <StartFrame>
      <h1 className="font-serif text-[clamp(2.2rem,5vw,3.2rem)] leading-[1.04] tracking-tight text-balance">
        Your own WildWorth, live, with no sign-up.
      </h1>
      <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-machine-muted">
        A private copy with a community steward, a supporter and the WildWorth
        team in it. Switch between them any time. Real AI agents and real
        satellite data; play money only.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button
          size="lg"
          onClick={() => void sandbox.open(LOOK_AROUND)}
          disabled={sandbox.busy !== null}
          aria-busy={busy || undefined}
          variant="on-image"
          className="font-semibold focus-visible:ring-card focus-visible:ring-offset-2 focus-visible:ring-offset-machine"
        >
          {busy ? <Spinner aria-hidden="true" /> : null}
          Open my sandbox
          {!busy && <ArrowRight aria-hidden="true" />}
        </Button>
        <NextLink
          href="/judge"
          className="text-sm text-machine-muted underline-offset-4 hover:text-machine-ink hover:underline"
        >
          First, the 3-minute story
        </NextLink>
      </div>
      {sandbox.error?.key === LOOK_AROUND.key && (
        <p role="alert" className="mt-3 text-sm text-clay">
          {sandbox.error.text}
        </p>
      )}
      <h2 className="mt-12 mb-3 text-sm font-medium text-machine-muted">
        Or start from any step
      </h2>
      <SandboxFlow sandbox={sandbox} />
    </StartFrame>
  );
}
