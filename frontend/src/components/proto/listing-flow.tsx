"use client";

import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  FileText,
  Info,
  Plus,
  RotateCcw,
  Sparkles,
  Undo2,
  Wand2,
} from "lucide-react";
import Link from "@/components/app-link";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";

import { ValueRange } from "@/components/proto/bits";
import { DrawMap } from "@/components/proto/draw-map";
import { GradeBadge, GradeStamp } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { RatingPipeline } from "@/components/proto/rating-pipeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { siteDataFor, type LatLng } from "@/lib/prototype/data";
import { GRADE_LABEL, ha, int, money, price } from "@/lib/prototype/format";
import { areaHa as polygonArea, checkPolygon } from "@/lib/prototype/geo";
import { fairValuePerUnit, TOTAL_UNITS } from "@/lib/prototype/rating";
import { usePrototype } from "@/lib/prototype/store";
import {
  HERO_ID,
  latestReport,
  launchOffer,
  rateDraft,
  registerCommunity,
  SAMPLE_DOCUMENTS,
  updateDraft,
} from "@/lib/prototype/world";

const STEPS = ["Details", "Boundary", "Evidence", "Rating", "Opening offer"];

const SAMPLE_DOCS = SAMPLE_DOCUMENTS;

export function ListingFlow() {
  const { world, act } = usePrototype();
  const draft = world.draft;
  const site = world.sites.find((s) => s.id === HERO_ID)!;
  const report = latestReport(site);
  const step =
    site.status === "listed"
      ? 5
      : report
        ? Math.max(draft.step, 4)
        : Math.min(draft.step, 3);
  const setStep = (n: number) => act((w) => updateDraft(w, { step: n }));

  return (
    <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">
      <Link
        href="/steward"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Community home
      </Link>
      <h1 className="mt-3 font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        List your land
      </h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Draw the land your community protects. NatureX rates it from satellite
        data and local news, then you decide whether to open it to supporters.
        The land always stays yours.
      </p>

      <ol className="mt-8 flex flex-wrap gap-2" aria-label="Listing steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium",
                i < step
                  ? "bg-primary text-primary-foreground"
                  : i === step
                    ? "bg-card text-foreground shadow-soft"
                    : "text-muted-foreground",
              )}
              aria-current={i === step ? "step" : undefined}
            >
              <span
                className={cn(
                  "tabular grid size-5 place-items-center rounded-full text-[11px]",
                  i < step
                    ? "bg-lime text-foreground"
                    : i === step
                      ? "bg-primary text-primary-foreground"
                      : "bg-foreground/10",
                )}
              >
                {i < step ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : (
                  i + 1
                )}
              </span>
              {label}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-6">
        {step === 0 && <DetailsStep onNext={() => setStep(1)} />}
        {step === 1 && (
          <BoundaryStep onBack={() => setStep(0)} onNext={() => setStep(2)} />
        )}
        {step === 2 && (
          <EvidenceStep onBack={() => setStep(1)} onNext={() => setStep(3)} />
        )}
        {step === 3 && <RatingStep onBack={() => setStep(2)} />}
        {step === 4 && <OfferStep />}
        {step === 5 && <ListedStep />}
      </div>
    </div>
  );
}

function StepCard({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "rounded-[1.75rem] bg-card p-6 shadow-soft sm:p-8",
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

function DetailsStep({ onNext }: { onNext: () => void }) {
  const { world, act } = usePrototype();
  const site = world.sites.find((s) => s.id === HERO_ID)!;
  const [community, setCommunity] = useState(world.community.name);
  const [description, setDescription] = useState(world.draft.description);
  return (
    <StepCard>
      <form
        className="grid gap-6 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          act((w) =>
            updateDraft(registerCommunity(w, community), {
              description,
              step: 1,
            }),
          );
          onNext();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="community">Community</Label>
          <Input
            id="community"
            value={community}
            onChange={(e) => setCommunity(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            You&apos;re the owner. Stewards can be added later.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="site-name">Site name</Label>
          <Input
            id="site-name"
            value={site.name}
            readOnly
            aria-describedby="site-name-note"
          />
          <p id="site-name-note" className="text-xs text-muted-foreground">
            Prefilled for the demo site.
          </p>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="description">
            What the land is and how you care for it
          </Label>
          <Textarea
            id="description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="grid gap-4 rounded-2xl bg-secondary p-4 text-sm sm:grid-cols-3 md:col-span-2">
          <div>
            <div className="text-xs text-muted-foreground">Total units</div>
            <div className="tabular font-medium">{int(TOTAL_UNITS)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Country</div>
            <div className="font-medium">Mexico</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              Who owns the land
            </div>
            <div className="font-medium">Your community, always</div>
          </div>
        </div>
        <div className="flex justify-end md:col-span-2">
          <Button type="submit">
            Continue to boundary
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

function BoundaryStep({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const { world, act } = usePrototype();
  const saved = siteDataFor("wetland_mx").polygon.slice(0, -1);
  const [points, setPoints] = useState<LatLng[]>(world.draft.polygon);
  const [animating, setAnimating] = useState(false);
  const timer = useRef<number | null>(null);
  const others = world.sites
    .filter((s) => s.id !== HERO_ID && s.status !== "draft")
    .map((s) => ({ name: s.name, polygon: s.polygon }));
  const check = useMemo(
    () => (points.length ? checkPolygon(points, others) : null),
    [points, others],
  );

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  function commit(next: LatLng[]) {
    setPoints(next);
    act((w) => updateDraft(w, { polygon: next }));
  }

  function useSaved() {
    if (timer.current) window.clearInterval(timer.current);
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) return commit(saved);
    setAnimating(true);
    let i = 0;
    setPoints([]);
    timer.current = window.setInterval(() => {
      i += 1;
      setPoints(saved.slice(0, i));
      if (i >= saved.length) {
        if (timer.current) window.clearInterval(timer.current);
        setAnimating(false);
        commit(saved);
      }
    }, 90);
  }

  return (
    <StepCard>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div data-tour="draw-map">
          <DrawMap
            points={points}
            onAdd={(p) => !animating && commit([...points, p])}
            center={siteDataFor("wetland_mx").centroid}
            others={others}
            valid={check?.ok ?? true}
          />
        </div>
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">Draw the boundary</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Click the map to add corners around the land. Or use the boundary
              your cooperative saved earlier.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={useSaved}
            disabled={animating}
            data-tour="use-saved-boundary"
          >
            <Wand2 aria-hidden="true" />
            Use saved boundary
          </Button>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => commit(points.slice(0, -1))}
              disabled={!points.length || animating}
            >
              <Undo2 aria-hidden="true" />
              Undo corner
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => commit([])}
              disabled={!points.length || animating}
            >
              <RotateCcw aria-hidden="true" />
              Clear
            </Button>
          </div>
          <div className="rounded-2xl bg-secondary p-4" aria-live="polite">
            <div className="text-xs text-muted-foreground">Area</div>
            <div className="tabular text-3xl font-light">
              {check ? ha(check.areaHa) : "0 ha"}
            </div>
            <div className="text-xs text-muted-foreground">
              {points.length} corners
            </div>
            {check && !check.ok && !animating && (
              <p className="mt-2 text-sm text-clay-ink">{check.message}</p>
            )}
            {check?.ok && (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-lime-ink">
                <Check className="size-4" aria-hidden="true" />
                Shape, size and overlap checks pass.
              </p>
            )}
          </div>
          {check?.ok &&
            !animating &&
            (points.length !== saved.length ||
              points.some(
                (p, i) => p[0] !== saved[i][0] || p[1] !== saved[i][1],
              )) && (
              <p className="text-xs text-muted-foreground">
                Prototype: a drawn boundary is rated with the demo
                wetland&apos;s cached satellite data, scaled to its area. Live
                rating of any boundary comes with the full build.
              </p>
            )}
          <p className="text-xs text-muted-foreground">
            Dashed outlines are sites already listed. Boundaries can&apos;t
            overlap them.
          </p>
          <div className="mt-auto flex justify-between">
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button onClick={onNext} disabled={!check?.ok || animating}>
              Continue
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </StepCard>
  );
}

function EvidenceStep({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const { world, act } = usePrototype();
  const { documents, photos } = world.draft;
  return (
    <StepCard>
      <div className="grid gap-8 md:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold">Documents for verification</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Up to three. A reviewer reads them before the site can open in the
            live world; in this sandbox you can list without them.
          </p>
          <ul className="mt-4 space-y-2">
            {SAMPLE_DOCS.map((doc) => {
              const added = documents.includes(doc);
              return (
                <li key={doc}>
                  <button
                    type="button"
                    onClick={() =>
                      act((w) =>
                        updateDraft(w, {
                          documents: added
                            ? documents.filter((d) => d !== doc)
                            : [...documents, doc],
                        }),
                      )
                    }
                    aria-pressed={added}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left text-sm transition-colors",
                      added
                        ? "border-lime bg-lime/15"
                        : "border-dashed border-input hover:bg-accent",
                    )}
                  >
                    <FileText
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="flex-1">{doc}</span>
                    {added ? (
                      <Check
                        className="size-4 text-lime-ink"
                        aria-label="attached"
                      />
                    ) : (
                      <Plus className="size-4" aria-label="attach" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Use sample documents (demo): nothing is uploaded and no real
            ownership is checked.
          </p>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Geotagged photos</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Photos taken inside the boundary in the last 90 days raise the
            rating&apos;s confidence.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={cn(
                  "grid aspect-square place-items-center rounded-2xl text-xs",
                  i < photos
                    ? "bg-[oklch(0.55_0.08_140)] text-white"
                    : "border border-dashed border-input text-muted-foreground",
                )}
              >
                {i < photos ? (
                  <span className="flex flex-col items-center gap-1">
                    <Camera className="size-4" aria-hidden="true" />
                    Photo {i + 1}
                  </span>
                ) : (
                  "Empty"
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                act((w) => updateDraft(w, { photos: Math.min(5, photos + 3) }))
              }
              disabled={photos >= 5}
            >
              <Camera aria-hidden="true" />
              Add 3 sample photos
            </Button>
            {photos > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => act((w) => updateDraft(w, { photos: 0 }))}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="mt-8 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>
          {documents.length || photos ? "Continue to rating" : "Skip for now"}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </StepCard>
  );
}

function RatingStep({ onBack }: { onBack: () => void }) {
  const { world, act } = usePrototype();
  const site = world.sites.find((s) => s.id === HERO_ID)!;
  const [playing, setPlaying] = useState(false);
  // The exact run rateDraft will store (pure, fixed seed), so the pipeline plays what the
  // Agent Trace shows afterwards.
  const preview = useMemo(() => {
    const rated = rateDraft(world);
    return rated.runs[rated.runs.length - 1];
  }, [world]);
  const drawnArea =
    world.draft.polygon.length >= 3
      ? polygonArea(world.draft.polygon)
      : site.areaHa;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <StepCard>
        <h2 className="text-lg font-semibold">Ready to rate</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div className="rounded-2xl bg-secondary p-4">
            <dt className="text-xs text-muted-foreground">Community</dt>
            <dd className="font-medium">{world.community.name}</dd>
          </div>
          <div className="rounded-2xl bg-secondary p-4">
            <dt className="text-xs text-muted-foreground">Area</dt>
            <dd className="tabular font-medium">{ha(drawnArea)}</dd>
          </div>
          <div className="rounded-2xl bg-secondary p-4">
            <dt className="text-xs text-muted-foreground">Documents</dt>
            <dd className="font-medium">
              {world.draft.documents.length || "None yet"}
            </dd>
          </div>
          <div className="rounded-2xl bg-secondary p-4">
            <dt className="text-xs text-muted-foreground">Photos</dt>
            <dd className="font-medium">{world.draft.photos || "None yet"}</dd>
          </div>
        </dl>
        <p className="mt-5 text-sm text-muted-foreground">
          The rating reads five years of satellite data, values what the land
          does, checks local news, and has an AI auditor cross-check it all.
          Every number comes from a tested formula; the AI explains and audits.
        </p>
        <div className="mt-6 flex justify-between">
          <Button variant="ghost" onClick={onBack} disabled={playing}>
            Back
          </Button>
          <Button
            size="lg"
            onClick={() => setPlaying(true)}
            disabled={playing}
            data-tour="rate-button"
          >
            <Sparkles aria-hidden="true" />
            {playing ? "Rating…" : "Rate this site"}
          </Button>
        </div>
      </StepCard>
      <section
        className="rounded-[1.75rem] bg-machine p-5 text-machine-ink shadow-soft"
        aria-label="Rating pipeline"
      >
        <div className="px-3 pt-1 pb-3">
          <h2 className="font-serif text-2xl">Rating pipeline</h2>
          <p className="text-sm text-machine-muted">
            {playing
              ? "Agents at work…"
              : "Steps light up as each agent and tool runs."}
          </p>
        </div>
        <RatingPipeline
          run={preview}
          play={playing}
          onDone={() => act(rateDraft)}
        />
      </section>
    </div>
  );
}

function OfferStep() {
  const { world, act } = usePrototype();
  const site = world.sites.find((s) => s.id === HERO_ID)!;
  const report = latestReport(site)!;
  const [retained, setRetained] = useState(world.draft.retainedPct);
  const offered = Math.round((TOTAL_UNITS * (100 - retained)) / 100);
  const fair = fairValuePerUnit(
    report.valueMid,
    report.health,
    report.confidence,
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <StepCard data-tour="report-card" className="relative overflow-hidden">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">
              Ecological Performance Report · v{report.version}
            </p>
            <h2 className="mt-1 font-serif text-4xl leading-tight">
              {site.name}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {GRADE_LABEL[report.grade]}
            </p>
          </div>
          <GradeStamp grade={report.grade} animate />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-6">
          <HealthRing value={report.health} size={150} />
          <ValueRange
            low={report.valueLow}
            mid={report.valueMid}
            high={report.valueHigh}
            confidence={report.confidence}
            className="min-w-0 flex-1"
          />
        </div>
        <ul className="mt-6 space-y-2 text-sm">
          <li
            className={cn("flex gap-2", !report.gatePassed && "text-clay-ink")}
          >
            {report.gatePassed ? (
              <Check
                className="mt-0.5 size-4 shrink-0 text-lime-ink"
                aria-hidden="true"
              />
            ) : (
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
            )}
            {report.gatePassed
              ? "Passes the listing gate: confidence ≥ 70, grade ≥ C, no significant forest loss this year."
              : "Doesn't pass the listing gate yet (confidence ≥ 70, grade ≥ C, forest loss under 1% this year). Add field evidence or follow the stewardship actions, then re-rate."}
          </li>
          <li className="flex gap-2">
            <Check
              className="mt-0.5 size-4 shrink-0 text-lime-ink"
              aria-hidden="true"
            />
            <span>
              Auditor (scripted in this prototype): {report.adjustmentReason}
            </span>
          </li>
          {report.flags.some((f) => f.code === "custom_boundary") && (
            <li className="flex gap-2 text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Drawn boundary: values use the demo site&apos;s cached land-cover
              shares, scaled to {ha(site.areaHa)}. Live rating of new boundaries
              comes with the full build.
            </li>
          )}
        </ul>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/asset/${site.id}?tab=report`}>
              Read the full report
            </Link>
          </Button>
        </div>
      </StepCard>
      <StepCard data-tour="offer-panel">
        <h2 className="text-lg font-semibold">Opening offer</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how much of the stake your community keeps. The rest opens to
          supporters at the fair price; what they pay for these units goes to
          your community fund.
        </p>
        <div className="mt-6 space-y-3">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="retained">Community keeps</Label>
            <span className="tabular text-2xl font-light">{retained}%</span>
          </div>
          <Slider
            id="retained"
            min={51}
            max={90}
            step={1}
            value={[retained]}
            onValueChange={([v]) => setRetained(v)}
            aria-label="Share the community keeps"
          />
          <p className="text-xs text-muted-foreground">
            At least 51%, so the community always holds the majority.
          </p>
        </div>
        <div className="mt-6 rounded-2xl bg-secondary p-4">
          <div className="text-sm font-medium">Opening price, step by step</div>
          <ol className="tabular mt-3 space-y-1.5 text-sm">
            <li className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                Annual value (mid) × 10 years
              </span>
              <span>{money(report.valueMid * 10)}</span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                × health factor 0.5 + 0.5 × {report.health.toFixed(1)}/100
              </span>
              <span>× {(0.5 + report.health / 200).toFixed(3)}</span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                × confidence factor 0.7 + 0.3 × {report.confidence.toFixed(0)}
                /100
              </span>
              <span>
                × {(0.7 + (0.3 * report.confidence) / 100).toFixed(3)}
              </span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                ÷ {int(TOTAL_UNITS)} units
              </span>
              <span className="font-semibold">{price(fair)} per unit</span>
            </li>
          </ol>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-2xl border p-3">
            <dt className="text-xs text-muted-foreground">Units offered</dt>
            <dd className="tabular text-lg font-light">{int(offered)}</dd>
          </div>
          <div className="rounded-2xl border p-3">
            <dt className="text-xs text-muted-foreground">If all are taken</dt>
            <dd className="tabular text-lg font-light">
              {money(offered * fair)}
            </dd>
          </div>
        </dl>
        <Button
          className="mt-6 w-full"
          size="lg"
          onClick={() =>
            act((w) =>
              launchOffer(updateDraft(w, { retainedPct: retained }), retained),
            )
          }
          disabled={!report.gatePassed}
          data-tour="launch-offer"
        >
          Launch opening offer
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          Sandbox: play money, not a real security. Supporters get a stake in
          the rating&apos;s sandbox market, never the land.
        </p>
      </StepCard>
    </div>
  );
}

function ListedStep() {
  const { world } = usePrototype();
  const site = world.sites.find((s) => s.id === HERO_ID)!;
  const report = latestReport(site);
  return (
    <StepCard className="text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-full bg-lime text-foreground">
        <Check className="size-7" aria-hidden="true" />
      </span>
      <h2 className="mt-4 font-serif text-4xl">
        {site.name} is open to supporters
      </h2>
      <p className="mx-auto mt-2 max-w-lg text-muted-foreground">
        Opening price {price(site.ipoPrice ?? site.price)} per unit. Your
        community keeps {site.retainedPct}% of the stake and all of the land.
      </p>
      {report && (
        <div className="mt-4 flex justify-center">
          <GradeBadge grade={report.grade} health={report.health} showLabel />
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link href={`/asset/${site.id}`}>See the public page</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/steward">Community home</Link>
        </Button>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        This prototype lists one site per community.
      </p>
    </StepCard>
  );
}
