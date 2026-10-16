"use client";

import { Compass, Sprout } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Stat } from "@/components/proto/bits";
import {
  changeSinceOpen,
  FeatureSiteCard,
  SiteCard,
} from "@/components/proto/site-card";
import { useTour } from "@/components/proto/tour";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { GRADE_ORDER, ha, money } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import { HERO_ID, latestReport, type Site } from "@/lib/prototype/world";

type SortKey = "grade" | "change" | "confidence" | "value";

const SORTS: Record<
  SortKey,
  { label: string; fn: (a: Site, b: Site) => number }
> = {
  grade: {
    label: "Best grade",
    fn: (a, b) =>
      GRADE_ORDER.indexOf(latestReport(a)!.grade) -
        GRADE_ORDER.indexOf(latestReport(b)!.grade) ||
      latestReport(b)!.health - latestReport(a)!.health,
  },
  change: {
    label: "Price change",
    fn: (a, b) => changeSinceOpen(b) - changeSinceOpen(a),
  },
  confidence: {
    label: "Confidence",
    fn: (a, b) => latestReport(b)!.confidence - latestReport(a)!.confidence,
  },
  value: {
    label: "Annual value",
    fn: (a, b) => latestReport(b)!.valueMid - latestReport(a)!.valueMid,
  },
};

export function Marketplace() {
  const { world } = usePrototype();
  const tour = useTour();
  const [eco, setEco] = useState("all");
  const [sort, setSort] = useState<SortKey>("grade");
  const listed = world.sites.filter(
    (s) => s.status !== "draft" && latestReport(s),
  );
  const hero = world.sites.find((s) => s.id === HERO_ID);
  const featured =
    hero && hero.status !== "draft"
      ? hero
      : [...listed].sort(SORTS.grade.fn)[0];
  const shown = useMemo(
    () =>
      listed
        .filter((s) => eco === "all" || s.ecosystem === eco)
        .sort(SORTS[sort].fn),
    [listed, eco, sort],
  );
  const funds = world.sites.reduce((sum, s) => sum + s.communityFund, 0);

  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
            Marketplace
          </h1>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Living land, rated by AI from satellite data and local news. Back a
            site with play money and follow its health every quarter.
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-6 rounded-3xl bg-card px-6 py-4 shadow-soft">
          <Stat label="Sites listed" value={listed.length} />
          <Stat
            label="Land rated"
            value={ha(listed.reduce((s, x) => s + x.areaHa, 0))}
          />
          <Stat label="Community funds" value={money(funds)} sub="play money" />
        </dl>
      </div>

      {!tour.active && (
        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-3xl bg-lichen px-5 py-3.5 text-sm">
          <Compass className="size-4 text-lime-ink" aria-hidden="true" />
          <span>
            <span className="font-medium">New here?</span> The guided tour walks
            through listing, rating, backing and monitoring in about seven
            minutes.
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" asChild>
              <Link href="/judge">Judge landing</Link>
            </Button>
            <Button size="sm" onClick={tour.start}>
              Start the tour
            </Button>
          </div>
        </div>
      )}

      {featured && (
        <div className="mt-8">
          <FeatureSiteCard site={featured} />
        </div>
      )}

      {hero?.status === "draft" && (
        <div className="mt-6 flex flex-wrap items-center gap-4 rounded-3xl border border-dashed border-input px-5 py-4">
          <span className="grid size-10 place-items-center rounded-2xl bg-lime/30 text-lime-ink">
            <Sprout className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">Coming soon: {hero.name}</div>
            <p className="text-sm text-muted-foreground">
              {hero.community} is preparing its listing. It opens here once
              it&apos;s rated.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/steward/list">See the listing flow</Link>
          </Button>
        </div>
      )}

      <section aria-labelledby="all-sites" className="mt-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 id="all-sites" className="text-xl font-semibold">
            All sites
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              value={eco}
              onValueChange={(v) => v && setEco(v)}
              className="rounded-full bg-card p-1 shadow-soft"
              aria-label="Filter by ecosystem"
            >
              {["all", "Wetland", "Mangrove", "Forest"].map((v) => (
                <ToggleGroupItem
                  key={v}
                  value={v}
                  className="rounded-full px-3.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  {v === "all" ? "All" : v}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="w-44" aria-label="Sort sites">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORTS) as SortKey[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    Sort: {SORTS[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="mt-6 rounded-3xl bg-card px-6 py-10 text-center text-muted-foreground shadow-soft">
            No {eco.toLowerCase()} sites are listed yet.
          </p>
        ) : (
          <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((s) => (
              <SiteCard key={s.id} site={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
