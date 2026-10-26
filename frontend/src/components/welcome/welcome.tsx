import { ArrowRight } from "lucide-react";
import NextLink from "next/link";

import { AskBeaButton } from "@/components/bea/ask-bea-button";
import { Lockup } from "@/components/brand";
import { MAIN_ID } from "@/components/shell/skip-link";
import { Button } from "@/components/ui/button";
import { BeaIntro } from "@/components/welcome/bea-intro";
import { WelcomeMap } from "@/components/welcome/welcome-map";

/**
 * `/`: the first thing anyone sees. Over the hero wetland, Bea flies in and writes the greeting,
 * the product is one plain sentence, and she lands in Ask Bea (`BeaIntro`), where she lives on
 * every page. Two ways on: the story (`/how`) or the visitor's own sandbox (`/sandbox`, no
 * sign-up); Ask Bea opens the sandbox with her chat open. The sandbox line appears once, at the
 * foot.
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

      <BeaIntro>
        <div className="relative z-[500] mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 sm:px-8">
          <header className="flex items-center py-6">
            <Lockup size={24} reading="lime" />
          </header>

          <div className="flex flex-1 items-start pt-6 min-[900px]:items-center min-[900px]:pt-0">
            <div className="max-w-[36rem] pb-10">
              <h1
                data-intro-write=""
                className="font-serif text-[clamp(3rem,7.2vw,5.75rem)] leading-[0.95] tracking-[-0.03em] text-balance"
              >
                Welcome to WildWorth.
              </h1>
              <p
                data-intro-rise="1"
                className="mt-6 max-w-[30ch] text-[clamp(1.15rem,1.7vw,1.4rem)] leading-snug text-machine-ink/85"
              >
                We rate living land with satellites and AI, so the people who
                protect it can get paid to keep it alive.
              </p>
              <div
                data-intro-rise="2"
                className="mt-9 flex flex-wrap items-center gap-3"
              >
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

        {/* Where Bea lands, and where she is on every page of the sandbox. */}
        <div
          data-intro-land=""
          className="fixed right-4 bottom-14 z-[900] sm:right-6 sm:bottom-10"
        >
          <p
            data-intro-hello=""
            aria-hidden="true"
            className="absolute right-0 bottom-full mb-3 rounded-2xl rounded-br-sm bg-card px-3.5 py-2 text-[15px] font-medium whitespace-nowrap text-foreground shadow-lift sm:right-auto sm:left-0 sm:rounded-br-2xl sm:rounded-bl-sm"
          >
            Hi, I&apos;m Bea.
          </p>
          <AskBeaButton
            href="/sandbox?ask=bea"
            className="h-12 pr-4 pl-1.5 text-[14px] shadow-lift max-sm:size-12 max-sm:p-2"
          />
        </div>
      </BeaIntro>
    </main>
  );
}
