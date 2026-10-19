"use client";

import {
  AlertTriangle,
  ArrowRight,
  Camera,
  Check,
  ExternalLink,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "cn";

import { Delta, SiteBackdrop, Stat } from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { Panel } from "@/components/proto/report-panels";
import { VerificationBadge } from "@/components/proto/verification";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { date, ha, int, money, price } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import {
  addEvidence,
  changeSinceOpen,
  HERO_ID,
  latestReport,
  previousReport,
  registerCommunity,
} from "@/lib/prototype/world";

export function StewardHome() {
  const { world, act } = usePrototype();
  const site = world.sites.find((s) => s.id === HERO_ID)!;
  const report = latestReport(site);
  const prev = previousReport(site);
  const [name, setName] = useState(world.community.name);
  const holders = (["investor"] as const)
    .map((t) => ({
      who: "Supporter",
      units: world.holdings[t].find((h) => h.siteId === HERO_ID)?.units ?? 0,
    }))
    .filter((h) => h.units > 0);
  const soldUnits = site.ipoPrice
    ? Math.round((site.totalUnits * (100 - site.retainedPct)) / 100) -
      site.primaryRemaining
    : 0;
  const retainedUnits = Math.round((site.totalUnits * site.retainedPct) / 100);
  const alerts = world.alerts.filter((a) => a.persona === "steward");
  const downgraded = prev && report && report.health < prev.health;

  if (!world.community.registered) {
    return (
      <div className="mx-auto max-w-5xl px-4 pt-10 sm:px-6">
        <div className="grid gap-8 lg:grid-cols-[1fr_420px] lg:items-center">
          <div>
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight sm:text-6xl">
              Get paid for keeping your land alive
            </h1>
            <p className="mt-4 max-w-xl text-lg text-muted-foreground">
              NatureX rates the land your community protects and lets supporters
              fund it, without you selling a single hectare.
            </p>
            <ol className="mt-6 space-y-3 text-sm">
              {[
                "Register your community",
                "Draw your land and get an AI rating in minutes",
                "Open it to supporters and grow your community fund",
              ].map((t, i) => (
                <li key={t} className="flex items-center gap-3">
                  <span className="tabular grid size-6 place-items-center rounded-full bg-lime text-xs font-semibold">
                    {i + 1}
                  </span>
                  {t}
                </li>
              ))}
            </ol>
          </div>
          <form
            className="rounded-[1.75rem] bg-card p-6 shadow-lift sm:p-8"
            data-tour="community-form"
            onSubmit={(e) => {
              e.preventDefault();
              act((w) => registerCommunity(w, name));
            }}
          >
            <h2 className="text-lg font-semibold">Register your community</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Prefilled for Rosa&apos;s cooperative. Edit anything.
            </p>
            <div className="mt-5 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="community-name">Community name</Label>
                <Input
                  id="community-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="region">Region</Label>
                  <Input id="region" defaultValue="Mexico City" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role">Your role</Label>
                  <Input id="role" value="Owner" readOnly />
                </div>
              </div>
            </div>
            <Button type="submit" className="mt-6 w-full" size="lg">
              Register community
            </Button>
            <p className="mt-3 text-xs text-muted-foreground">
              Demo persona: no password, private to your sandbox.
            </p>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Rosa · owner</p>
          <h1 className="mt-1 font-serif text-5xl leading-none tracking-tight sm:text-6xl">
            {world.community.name}
          </h1>
        </div>
        {site.status === "draft" && !report && (
          <Button asChild size="lg">
            <Link href="/steward/list">
              List your land
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        )}
      </div>

      <dl className="mt-8 grid gap-4 rounded-3xl bg-card p-6 shadow-soft sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Community fund"
          value={money(site.communityFund, { compact: false })}
          sub="opening-offer proceeds · play money"
        />
        <Stat
          label="Retained stake"
          value={site.ipoPrice ? money(retainedUnits * site.price) : "—"}
          sub={
            site.ipoPrice
              ? `${int(retainedUnits)} units (${site.retainedPct}%)`
              : "set at the opening offer"
          }
        />
        <Stat
          label="Units taken by supporters"
          value={int(soldUnits)}
          sub={
            site.ipoPrice
              ? `of ${int(site.totalUnits - retainedUnits)} offered`
              : "not open yet"
          }
        />
        <Stat
          label="Land"
          value={ha(site.areaHa)}
          sub="owned by the community, always"
        />
      </dl>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-8">
          {!report ? (
            <section className="relative isolate overflow-hidden rounded-[2rem] p-8 text-white shadow-lift">
              <SiteBackdrop siteKey={site.key} />
              <div className="relative max-w-lg">
                <h2 className="font-serif text-4xl">{site.name}</h2>
                <p className="mt-2 text-white/85">
                  Not listed yet. Draw the boundary and get the first rating: it
                  takes a few minutes and you decide afterwards whether to open
                  it to supporters.
                </p>
                <Button
                  asChild
                  className="mt-6 bg-lime text-foreground hover:bg-lime/90"
                >
                  <Link href="/steward/list">Start the listing</Link>
                </Button>
              </div>
            </section>
          ) : (
            <section className="relative isolate overflow-hidden rounded-[2rem] text-white shadow-lift">
              <SiteBackdrop siteKey={site.key} />
              <div className="relative grid gap-6 p-6 sm:p-8 md:grid-cols-[auto_1fr]">
                <HealthRing value={report.health} tone="dark" size={160} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <GradeBadge grade={report.grade} size="lg" />
                    <VerificationBadge
                      level={site.verification}
                      tone="image"
                      compact
                    />
                    <span className="rounded-full bg-white/15 px-2.5 py-1 text-xs">
                      {site.status === "listed"
                        ? "Open to supporters"
                        : site.status === "suspended"
                          ? "Trading paused"
                          : "Rated, not open yet"}
                    </span>
                  </div>
                  <h2 className="mt-3 font-serif text-4xl">{site.name}</h2>
                  {site.ipoPrice ? (
                    <p className="mt-2 text-white/85">
                      Stake price{" "}
                      <span className="tabular">{price(site.price)}</span>{" "}
                      <Delta
                        value={changeSinceOpen(site)}
                        suffix="since opening"
                        className="text-white [&_span]:text-white/90"
                      />
                    </p>
                  ) : (
                    <p className="mt-2 text-white/85">
                      Rated {date(report.createdAt)}. Launch the opening offer
                      when you&apos;re ready.
                    </p>
                  )}
                  <div className="mt-5 flex flex-wrap gap-2">
                    {site.status === "draft" ? (
                      <Button
                        asChild
                        className="bg-lime text-foreground hover:bg-lime/90"
                      >
                        <Link href="/steward/list">Launch opening offer</Link>
                      </Button>
                    ) : (
                      <Button
                        asChild
                        className="bg-lime text-foreground hover:bg-lime/90"
                      >
                        <Link href={`/asset/${site.id}`}>
                          Public page
                          <ExternalLink aria-hidden="true" />
                        </Link>
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                      onClick={() => act((w) => addEvidence(w, HERO_ID, 3))}
                      disabled={site.photos >= 5}
                    >
                      <Camera aria-hidden="true" />
                      Add 3 field photos
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-white/70">
                    {site.photos ? `${site.photos} photos on file. ` : ""}Photos
                    re-run the rating with field evidence and raise confidence.
                  </p>
                </div>
              </div>
            </section>
          )}

          {report && (
            <section
              className={cn(
                "rounded-3xl p-6 shadow-soft",
                downgraded ? "bg-clay/10 ring-1 ring-clay/40" : "bg-card",
              )}
              data-tour="stewardship-actions"
              aria-labelledby="actions-title"
            >
              <div className="flex flex-wrap items-center gap-2">
                {downgraded && (
                  <AlertTriangle
                    className="size-5 text-clay-ink"
                    aria-hidden="true"
                  />
                )}
                <h2 id="actions-title" className="text-base font-semibold">
                  {downgraded
                    ? `Recover the rating: ${prev.grade} → ${report.grade}`
                    : "Stewardship actions"}
                </h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {downgraded
                  ? "The latest report found pressure on your site. These steps address what the data shows."
                  : "Concrete steps from the latest report that would strengthen the rating."}
              </p>
              <ul className="mt-4 space-y-3">
                {report.recommendations.map((r) => (
                  <li
                    key={r}
                    className="flex gap-3 rounded-2xl bg-card/70 p-3 text-sm"
                  >
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-lime-ink"
                      aria-hidden="true"
                    />
                    {r}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="space-y-6">
          <Panel title="Alerts">
            {alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No alerts yet. You&apos;ll hear here when your site is re-rated.
              </p>
            ) : (
              <ul className="space-y-3">
                {alerts.slice(0, 5).map((a) => (
                  <li key={a.id} className="text-sm">
                    <div className="font-medium">{a.title}</div>
                    <div className="text-muted-foreground">{a.message}</div>
                    <div className="text-xs text-muted-foreground">
                      {date(a.date)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Supporters">
            {holders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {site.ipoPrice
                  ? "No supporters yet. Share your public page."
                  : "Supporters appear after the opening offer."}
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {holders.map((h, i) => (
                  <li key={i} className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-2">
                      <Users
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {h.who} {i + 1}
                    </span>
                    <span className="tabular text-muted-foreground">
                      {int(h.units)} units
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Supporters are shown without names.
            </p>
          </Panel>
          <Panel title="Members">
            <ul className="space-y-2 text-sm">
              <li className="flex items-center justify-between">
                <span>Rosa</span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">
                  Owner
                </span>
              </li>
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Members can&apos;t trade their own site&apos;s stakes.
            </p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
