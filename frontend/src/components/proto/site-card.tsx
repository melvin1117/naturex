"use client";

import { ArrowRight, MapPin } from "lucide-react";
import Link from "next/link";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { cn } from "cn";

import {
  Delta,
  SiteBackdrop,
  SiteThumb,
  ValueRange,
} from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { VerificationBadge } from "@/components/proto/verification";
import { Button } from "@/components/ui/button";
import { ha, money, price } from "@/lib/prototype/format";
import { latestReport, type Site } from "@/lib/prototype/world";

export function changeSinceOpen(site: Site) {
  const first = site.prices[0]?.price;
  return first ? ((site.price - first) / first) * 100 : 0;
}

export function MiniPrice({
  site,
  className,
  stroke = "var(--primary)",
}: {
  site: Site;
  className?: string;
  stroke?: string;
}) {
  const data = site.prices.slice(-90).map((p) => ({ p: p.price }));
  return (
    <div className={cn("h-12 w-full", className)} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 4, bottom: 0, left: 0, right: 0 }}
        >
          <defs>
            <linearGradient id={`mini-${site.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Area
            type="monotone"
            dataKey="p"
            stroke={stroke}
            strokeWidth={1.5}
            fill={`url(#mini-${site.id})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SiteCard({ site }: { site: Site }) {
  const report = latestReport(site);
  if (!report) return null;
  return (
    <Link
      href={`/asset/${site.id}`}
      className="group flex flex-col overflow-hidden rounded-3xl bg-card shadow-soft transition-shadow hover:shadow-lift focus-visible:shadow-lift"
    >
      <div className="relative">
        <SiteThumb
          siteKey={site.key}
          alt={`Satellite view of ${site.name}`}
          className="aspect-[16/9]"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <span className="rounded-full bg-card/90 px-2.5 py-1 text-xs font-medium backdrop-blur">
            {site.ecosystem}
          </span>
          {site.status === "suspended" && (
            <span className="rounded-full bg-clay px-2.5 py-1 text-xs font-medium text-white">
              Trading paused
            </span>
          )}
        </div>
        <div className="absolute right-3 bottom-3">
          <GradeBadge grade={report.grade} />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <h3 className="text-lg leading-tight font-semibold">{site.name}</h3>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
            <MapPin className="size-3.5" aria-hidden="true" />
            {site.place} · {ha(site.areaHa)}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted-foreground">Stake price</div>
            <div className="tabular mt-0.5 text-xl font-light">
              {price(site.price)}
            </div>
            <Delta
              value={changeSinceOpen(site)}
              suffix="since opening"
              className="text-xs"
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              Health · confidence
            </div>
            <div className="tabular mt-0.5 text-xl font-light">
              {report.health.toFixed(1)}
            </div>
            <div className="text-xs text-muted-foreground">
              {report.confidence.toFixed(0)}% confidence
            </div>
          </div>
        </div>
        <MiniPrice site={site} />
        <div className="mt-auto flex items-center justify-between border-t pt-3 text-sm">
          <span className="tabular text-muted-foreground">
            {money(report.valueLow)}–{money(report.valueHigh)} /yr
          </span>
          <span className="inline-flex items-center gap-1 font-medium">
            View site
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </span>
        </div>
      </div>
    </Link>
  );
}

export function FeatureSiteCard({ site }: { site: Site }) {
  const report = latestReport(site);
  if (!report) return null;
  return (
    <section
      aria-labelledby={`feature-${site.id}`}
      className="relative isolate overflow-hidden rounded-[2rem] text-white shadow-lift"
      data-tour="feature-card"
    >
      <SiteBackdrop siteKey={site.key} />
      <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[auto_1fr_auto] lg:items-center lg:gap-10 lg:p-10">
        <HealthRing
          value={report.health}
          tone="dark"
          size={188}
          className="mx-auto lg:mx-0"
        />
        <div className="min-w-0 space-y-5">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-white/80">
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 backdrop-blur">
                {site.ecosystem}
              </span>
              <span>{site.place}</span>
              <span aria-hidden="true">·</span>
              <span>{ha(site.areaHa)}</span>
            </div>
            <h2
              id={`feature-${site.id}`}
              className="mt-3 font-serif text-4xl leading-[1.05] tracking-tight sm:text-5xl"
            >
              {site.name}
            </h2>
            <p className="mt-2 text-sm text-white/80">
              Stewarded by {site.community}
            </p>
          </div>
          <ValueRange
            low={report.valueLow}
            mid={report.valueMid}
            high={report.valueHigh}
            confidence={report.confidence}
            tone="image"
            className="max-w-md"
          />
        </div>
        <div className="flex flex-col gap-4 rounded-3xl bg-white/12 p-5 backdrop-blur-md lg:w-64">
          <div className="flex items-center justify-between">
            <GradeBadge grade={report.grade} size="lg" />
            <VerificationBadge level={site.verification} tone="image" compact />
          </div>
          <div>
            <div className="text-xs text-white/75">
              Stake price · play money
            </div>
            <div className="tabular text-3xl font-light">
              {price(site.price)}
            </div>
            <Delta
              value={changeSinceOpen(site)}
              suffix="since opening"
              className="text-white [&_span]:text-white/90"
            />
          </div>
          <Button asChild className="bg-lime text-foreground hover:bg-lime/90">
            <Link href={`/asset/${site.id}`}>Back this site</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
