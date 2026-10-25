"use client";

import { ArrowRight } from "lucide-react";
import NextLink from "next/link";

import { Bea } from "@/components/bea/bea";
import { Lockup } from "@/components/brand";
import { MAIN_ID } from "@/components/shell/skip-link";
import { Button } from "@/components/ui/button";
import { WelcomeMap } from "@/components/welcome/welcome-map";

/**
 * `/`: the first thing anyone sees. Bea flies in over the hero wetland, says hello, and the
 * product is one plain sentence. Two ways on: the story (`/how`) or the visitor's own sandbox
 * (`/sandbox`, no sign-up). The sandbox line appears once, at the foot.
 */
export function Welcome() {
  return (
    <main
      id={MAIN_ID}
      tabIndex={-1}
      className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-machine text-machine-ink outline-none"
    >
      <WelcomeMap />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[401] bg-[linear-gradient(180deg,rgb(14_28_22/0.92)_0%,rgb(14_28_22/0.7)_48%,rgb(14_28_22/0.15)_78%,rgb(14_28_22/0.55)_100%)] min-[900px]:bg-[linear-gradient(90deg,rgb(14_28_22/0.95)_0%,rgb(14_28_22/0.82)_34%,rgb(14_28_22/0.25)_58%,transparent_75%),linear-gradient(0deg,rgb(14_28_22/0.55)_0%,transparent_30%)]"
      />

      <div className="relative z-[500] mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 sm:px-8">
        <header className="flex items-center py-6">
          <Lockup size={24} reading="lime" />
        </header>

        <div className="flex flex-1 items-start pt-6 min-[900px]:items-center min-[900px]:pt-0">
          <div className="max-w-[36rem] pb-10">
            <div className="flex items-end gap-3">
              <span className="welcome-bea text-machine-ink">
                <Bea size={96} state="hello" label="Bea, the field guide" />
              </span>
              <p className="welcome-rise welcome-bubble mb-6 rounded-2xl rounded-bl-sm bg-card px-3.5 py-2 text-[15px] font-medium text-foreground shadow-lift [animation-delay:1.2s]">
                Hi, I&apos;m Bea.
              </p>
            </div>
            <h1 className="welcome-rise mt-5 font-serif text-[clamp(3rem,7.2vw,5.75rem)] leading-[0.95] tracking-[-0.03em] text-balance [animation-delay:0.35s]">
              Welcome to WildWorth.
            </h1>
            <p className="welcome-rise mt-6 max-w-[30ch] text-[clamp(1.15rem,1.7vw,1.4rem)] leading-snug text-machine-ink/85 [animation-delay:0.5s]">
              We rate living land with satellites and AI, so the people who
              protect it can get paid to keep it alive.
            </p>
            <div className="welcome-rise mt-9 flex flex-wrap items-center gap-3 [animation-delay:0.65s]">
              <Button asChild size="lg" variant="on-image">
                <NextLink href="/how">
                  Show me how
                  <ArrowRight aria-hidden="true" />
                </NextLink>
              </Button>
              <Button asChild size="lg" variant="on-image-outline">
                <NextLink href="/sandbox">Try it yourself</NextLink>
              </Button>
            </div>
          </div>
        </div>

        {/* Clear of the map's credits, which sit along the bottom edge. */}
        <footer className="pb-10 text-xs text-machine-muted min-[900px]:pb-8">
          Sandbox · play money only · a hackathon prototype
        </footer>
      </div>
    </main>
  );
}
