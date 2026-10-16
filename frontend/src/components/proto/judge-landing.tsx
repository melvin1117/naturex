"use client";

import {
  ArrowRight,
  Building2,
  Map as MapIcon,
  Sprout,
  TrendingUp,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Wordmark } from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { useTour } from "@/components/proto/tour";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import { latestReport, PERSONAS, type PersonaKey } from "@/lib/prototype/world";

const ENTRIES: {
  persona: PersonaKey;
  title: string;
  body: string;
  icon: typeof Sprout;
}[] = [
  {
    persona: "steward",
    title: "Explore as a community steward",
    body: "List Rosa's wetland, get it rated and open it to supporters.",
    icon: Sprout,
  },
  {
    persona: "investor",
    title: "Explore as an investor",
    body: "Compare rated sites, back one with play money, follow alerts.",
    icon: TrendingUp,
  },
  {
    persona: "admin",
    title: "Explore as the platform admin",
    body: "Run the Time Machine, inject events, review verifications.",
    icon: Building2,
  },
];

export function JudgeLanding() {
  const { world, setPersona } = usePrototype();
  const tour = useTour();
  const router = useRouter();
  const proof = world.sites.find((s) => s.id === "celestun-mangrove");
  const report = proof && latestReport(proof);

  return (
    <div className="relative isolate flex min-h-[calc(100dvh-44px)] flex-col overflow-hidden">
      <div className="absolute inset-0 -z-10" aria-hidden="true">
        <Image
          src="/demo-sites/wetland_mx.thumbnail.webp"
          alt=""
          fill
          priority
          unoptimized
          sizes="100vw"
          className="scale-110 object-cover blur-xl saturate-[1.1]"
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,oklch(0.932_0.012_128/0.55),oklch(0.932_0.012_128/0.92)_55%,var(--background))]" />
      </div>

      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-6 sm:px-6">
        <Wordmark />
        <nav className="flex items-center gap-2 text-sm">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/register">Create a real account</Link>
          </Button>
        </nav>
      </header>

      <main className="mx-auto grid w-full max-w-7xl flex-1 items-center gap-12 px-4 pb-16 sm:px-6 lg:grid-cols-[1.2fr_1fr]">
        <div>
          <h1 className="font-serif text-6xl leading-[0.95] tracking-tight text-balance sm:text-7xl lg:text-[5.5rem]">
            The bees never sent an <em className="italic">invoice.</em>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-foreground/80">
            NatureX is an AI rating agency for living land. Nemotron agents read
            satellite data and local news, rate a site&apos;s health and value
            with honest ranges, and keep watching, so keeping nature alive can
            pay more than destroying it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={tour.start}>
              <MapIcon aria-hidden="true" />
              Start the guided tour
            </Button>
            <span className="text-sm text-muted-foreground">
              About 7 minutes, 10 chapters, skip any time.
            </span>
          </div>
          <ul className="mt-10 grid gap-3 sm:grid-cols-3">
            {ENTRIES.map(({ persona, title, body, icon: Icon }) => (
              <li key={persona}>
                <button
                  type="button"
                  onClick={() => {
                    setPersona(persona);
                    router.push(PERSONAS[persona].home);
                  }}
                  className="group flex h-full w-full flex-col gap-3 rounded-3xl bg-card/90 p-4 text-left shadow-soft backdrop-blur transition hover:shadow-lift"
                >
                  <span className="grid size-9 place-items-center rounded-xl bg-lime/40 text-lime-ink">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="text-sm font-semibold">{title}</span>
                  <span className="text-xs text-muted-foreground">{body}</span>
                  <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium">
                    Open
                    <ArrowRight
                      className="size-3.5 transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {proof && report && (
          <div className="relative mx-auto w-full max-w-md">
            <div className="relative isolate overflow-hidden rounded-[2rem] text-white shadow-lift">
              <Image
                src={`/demo-sites/${proof.key}.thumbnail.webp`}
                alt={`Sentinel-2 image of ${proof.name}`}
                fill
                unoptimized
                sizes="420px"
                className="-z-10 object-cover"
              />
              <div className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,transparent,oklch(0.22_0.04_155/0.85))]" />
              <div className="flex min-h-[420px] flex-col justify-end gap-5 p-6">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-sm text-white/80">{proof.place}</p>
                    <h2 className="font-serif text-4xl leading-tight">
                      {proof.name}
                    </h2>
                  </div>
                  <GradeBadge grade={report.grade} size="lg" />
                </div>
                <div className="flex items-center gap-5 rounded-3xl bg-black/25 p-4 backdrop-blur-md">
                  <HealthRing value={report.health} tone="dark" size={112} />
                  <div className="text-sm">
                    <div className="tabular text-xl font-light">
                      {money(report.valueLow)}–{money(report.valueHigh)}
                    </div>
                    <div className="text-white/75">
                      ecosystem services a year
                    </div>
                    <div className="mt-2 text-white/75">
                      {report.confidence.toFixed(0)}% confidence
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Satellite metrics and formulas are real (cached Earth Engine
              data); the Auditor&apos;s review is scripted in this prototype.
            </p>
          </div>
        )}
      </main>

      <footer className="mx-auto w-full max-w-7xl px-4 pb-6 text-xs text-muted-foreground sm:px-6">
        Each visitor gets a private sandbox. Play money only: nothing here is a
        real security or investment.
      </footer>
    </div>
  );
}
