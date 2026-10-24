"use client";

import { ArrowRight } from "lucide-react";
import NextLink from "next/link";

import { SandboxIcon } from "@/components/icons";
import { useWorld } from "@/lib/hooks";

/** The sandbox line (ux-writing §4): WildWorth's play-money framing, always on screen. */
export const SANDBOX_LINE = "Sandbox · play money only";

/**
 * The strip above the app bar, as in the brand guidelines' app (chapter 12, "In use"): the
 * sandbox line, so nothing reads as a real security or exchange. Inside a visitor's sandbox
 * the sandbox bar, with its people and roles, takes its place. Anonymous visitors also get
 * the way into a sandbox of their own.
 */
export function SandboxStrip() {
  const { world, status } = useWorld();
  const anonymous = status === "ready" && !world?.me;
  return (
    <div className="bg-primary text-primary-foreground">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-1.5 text-xs sm:px-6">
        <p className="flex min-w-0 items-center gap-2">
          <SandboxIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="font-medium whitespace-nowrap">{SANDBOX_LINE}</span>
          <span className="hidden truncate text-primary-foreground/75 md:inline">
            Nothing here is a real security or investment.
          </span>
        </p>
        {anonymous && (
          // Into the visitor's own sandbox: plain next/link, never a sandbox-prefixed path.
          <NextLink
            href="/sandbox"
            className="inline-flex shrink-0 items-center gap-1 rounded-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary-foreground/60 focus-visible:outline-none"
          >
            <span className="sm:hidden">Your own sandbox</span>
            <span className="hidden sm:inline">
              Try it in your own sandbox, no sign-up
            </span>
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </NextLink>
        )}
      </div>
    </div>
  );
}
