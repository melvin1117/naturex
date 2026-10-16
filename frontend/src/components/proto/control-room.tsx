"use client";

import {
  ArrowRight,
  CloudRain,
  Factory,
  FastForward,
  Pause,
  Play,
  ShieldCheck,
  Sprout,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "cn";

import { LiveBadge } from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { Panel } from "@/components/proto/report-panels";
import { VerificationBadge } from "@/components/proto/verification";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { QUARTERS } from "@/lib/prototype/data";
import { date, price, quarterLabel } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import {
  HERO_ID,
  injectEvent,
  latestReport,
  nextQuarter,
  setSuspended,
  setVerification,
} from "@/lib/prototype/world";

export function ControlRoom() {
  const { world, act, openTrace } = usePrototype();
  const rated = world.sites.filter((s) => s.reports.length);
  const [siteId, setSiteId] = useState<string>(HERO_ID);
  const target = rated.find((s) => s.id === siteId) ?? rated[0];
  const atEnd = world.quarter >= QUARTERS.length - 1;

  const changes = world.sites
    .flatMap((s) =>
      s.reports
        .slice(1)
        .map((r, i) => ({ site: s, report: r, prev: s.reports[i] })),
    )
    .sort((a, b) =>
      a.report.createdAt < b.report.createdAt
        ? 1
        : a.report.createdAt > b.report.createdAt
          ? -1
          : b.report.version - a.report.version,
    )
    .slice(0, 8);

  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            Control room · sandbox only
          </p>
          <h1 className="mt-1 font-serif text-5xl leading-none tracking-tight sm:text-6xl">
            Time Machine
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Move the sandbox forward a quarter or inject an event, and watch
            ratings, prices and alerts respond. Scenarios replay scripted
            satellite changes for the demo sites (T13).
          </p>
        </div>
      </div>

      <section
        className="mt-8 rounded-[2rem] bg-machine p-6 text-machine-ink shadow-lift sm:p-8"
        aria-labelledby="timeline-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 id="timeline-title" className="font-serif text-3xl">
            Now: {quarterLabel(QUARTERS[world.quarter])}
          </h2>
          <span className="text-sm text-machine-muted">
            Sandbox date {date(world.today)}
          </span>
        </div>
        <ol className="mt-8 grid grid-cols-3 gap-2" aria-label="Quarters">
          {QUARTERS.map((q, i) => (
            <li key={q} className="relative">
              <div
                className={cn(
                  "h-1.5 rounded-full",
                  i <= world.quarter ? "bg-lime" : "bg-machine-line",
                )}
              />
              <div className="mt-3 flex items-center gap-2">
                <span
                  className={cn(
                    "grid size-7 place-items-center rounded-full text-xs font-semibold",
                    i < world.quarter
                      ? "bg-lime text-machine"
                      : i === world.quarter
                        ? "bg-machine-ink text-machine"
                        : "bg-machine-raised text-machine-muted",
                  )}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <div>
                  <div
                    className={cn(
                      "text-sm font-medium",
                      i > world.quarter && "text-machine-muted",
                    )}
                  >
                    {quarterLabel(q)}
                  </div>
                  <div className="text-xs text-machine-muted">
                    {i === 0
                      ? "Real satellite data"
                      : i === 1
                        ? "Scripted: restoration"
                        : "Scripted: continues"}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button
            size="lg"
            className="bg-lime text-machine hover:bg-lime/90"
            onClick={() => act(nextQuarter)}
            disabled={atEnd}
            data-tour="next-quarter"
          >
            <FastForward aria-hidden="true" />
            {atEnd ? "End of the scripted timeline" : "Next quarter"}
          </Button>
          <LiveBadge
            className="bg-lime/15 text-lime"
            label="Live Auditor call"
          />
          <span className="text-sm text-machine-muted">
            Re-rates every rated site and re-anchors prices. Reset the demo to
            start over.
          </span>
        </div>
      </section>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Inject an event">
          {rated.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rated sites yet.</p>
          ) : (
            <>
              <Select value={target?.id} onValueChange={setSiteId}>
                <SelectTrigger className="w-full" aria-label="Site">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rated.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() =>
                    target &&
                    act((w) => injectEvent(w, target.id, "encroachment"))
                  }
                  className="group flex flex-col items-start gap-3 rounded-3xl bg-clay/10 p-5 text-left ring-1 ring-clay/30 transition hover:bg-clay/15 focus-visible:ring-2"
                  data-tour="inject-encroachment"
                >
                  <span className="grid size-10 place-items-center rounded-2xl bg-clay text-white">
                    <Factory className="size-5" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block font-semibold">Encroachment</span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      Industrial fill at the edge: land turns built-up, water
                      drains, a news report appears.
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    target &&
                    act((w) => injectEvent(w, target.id, "restoration"))
                  }
                  className="group flex flex-col items-start gap-3 rounded-3xl bg-lime/15 p-5 text-left ring-1 ring-lime/50 transition hover:bg-lime/25 focus-visible:ring-2"
                >
                  <span className="grid size-10 place-items-center rounded-2xl bg-grade-aa text-white">
                    <Sprout className="size-5" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block font-semibold">Restoration</span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      Canals re-flooded and native trees replanted: greener,
                      wetter land.
                    </span>
                  </span>
                </button>
              </div>
              <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <CloudRain className="size-3.5" aria-hidden="true" />
                Fire and drought presets need scenario data that isn&apos;t
                precomputed yet, so they&apos;re left out rather than invented.
              </p>
            </>
          )}
        </Panel>

        <Panel title="What changed">
          {changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Move to the next quarter or inject an event.
            </p>
          ) : (
            <ul className="divide-y">
              {changes.map(({ site, report, prev }) => {
                const run = world.runs.find((r) => r.id === report.runId);
                return (
                  <li
                    key={`${site.id}-${report.version}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/asset/${site.id}?tab=report`}
                        className="text-sm font-medium hover:underline"
                      >
                        {site.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        Report v{report.version} · {quarterLabel(report.period)}{" "}
                        · {report.scenario}
                      </div>
                    </div>
                    <span className="flex items-center gap-1.5">
                      <GradeBadge grade={prev.grade} size="sm" />
                      <ArrowRight
                        className="size-3.5 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <GradeBadge grade={report.grade} size="sm" />
                    </span>
                    {run && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => openTrace(run.id)}
                      >
                        Trace
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Sites" className="mt-8">
        <div className="-mx-6 overflow-x-auto px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {world.sites.map((s) => {
                const r = latestReport(s);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="capitalize">
                      {s.status === "draft"
                        ? r
                          ? "Rated, not open"
                          : "Draft"
                        : s.status === "suspended"
                          ? "Paused"
                          : "Listed"}
                    </TableCell>
                    <TableCell>
                      {r ? <GradeBadge grade={r.grade} size="sm" /> : "—"}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {s.ipoPrice ? price(s.price) : "—"}
                    </TableCell>
                    <TableCell>
                      <VerificationBadge level={s.verification} compact />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {s.verification !== "verified" &&
                          s.documents.length > 0 && (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                act((w) => setVerification(w, s.id, "verified"))
                              }
                            >
                              <ShieldCheck aria-hidden="true" />
                              Approve sample documents
                            </Button>
                          )}
                        {s.status !== "draft" && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              act((w) =>
                                setSuspended(w, s.id, s.status === "listed"),
                              )
                            }
                          >
                            {s.status === "listed" ? (
                              <Pause aria-hidden="true" />
                            ) : (
                              <Play aria-hidden="true" />
                            )}
                            {s.status === "listed" ? "Pause trading" : "Resume"}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Approving documents writes a verification entry to the Nature Ledger
          with the reviewer&apos;s role, never a name (ADR-0006).
        </p>
      </Panel>
    </div>
  );
}
