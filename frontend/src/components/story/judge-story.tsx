"use client";

import {
  ArrowRight,
  BellRing,
  BrainCircuit,
  Eye,
  HandCoins,
  Newspaper,
  Satellite,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sprout,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "cn";

import {
  EMPTY_CHAIN,
  StoryChain,
  type ChainState,
} from "@/components/story/story-chain";
import { Lockup } from "@/components/brand";
import {
  LOOK_AROUND,
  SandboxFlow,
  useOpenSandbox,
} from "@/components/sandbox/sandbox-flow";
import { StoryMap, type StoryMapHandle } from "@/components/story/story-map";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { Story } from "@/lib/api/types";
import { useRecordedRun, useStory } from "@/lib/hooks";
import type { Grade } from "@/lib/prototype/data";
import { date } from "@/lib/prototype/format";
import {
  change,
  dollars,
  health,
  share,
  sparkline,
  STORY_SITE,
  storyEvidence,
  storyRatings,
  valueRange,
  type StoryEvidence,
} from "@/lib/story";

const SCENES = 6;
const LAST = SCENES - 1;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const on = () => setReduced(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  return reduced;
}

function useWide(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px)");
    setWide(query.matches);
    const on = () => setWide(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  return wide;
}

/**
 * `/judge`: why WildWorth exists, told on one real wetland in a couple of minutes, then the
 * judge's own private sandbox (no sign-up). Every number comes from `GET /story` (the product's
 * own rating, market and ledger code) and the wetland's recorded run (a real run of the agents).
 */
export function JudgeStory() {
  const story = useStory();
  const recorded = useRecordedRun(STORY_SITE);
  if (story.data)
    return (
      <StoryStage
        story={story.data}
        evidence={recorded.data ? storyEvidence(recorded.data) : null}
      />
    );
  return (
    <main
      id="main"
      className="fixed inset-0 grid place-items-center bg-machine text-machine-ink"
    >
      {story.error ? (
        <div className="max-w-md px-6 text-center">
          <p className="font-serif text-3xl">The story couldn&apos;t load.</p>
          <p className="mt-3 text-machine-muted">
            The service may be waking up; it takes about half a minute.
          </p>
          <Button
            variant="on-image"
            className="mt-6"
            onClick={() => void story.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <p role="status" className="flex items-center gap-3 text-machine-muted">
          <Spinner className="size-4" aria-hidden="true" role="presentation" />{" "}
          Loading the satellite view…
        </p>
      )}
    </main>
  );
}

type Stage = {
  story: Story;
  evidence: StoryEvidence | null;
  map: RefObject<StoryMapHandle | null>;
  setChain: (update: (c: ChainState) => ChainState) => void;
  alert: (a: AlertCard | null) => void;
  next: () => void;
  /** False once the scene is left (skip, back): stop the running sequence. */
  alive: () => boolean;
  reduced: boolean;
};

type AlertCard = { to: string; title: string; body: string };

function StoryStage({
  story,
  evidence,
}: {
  story: Story;
  evidence: StoryEvidence | null;
}) {
  const reduced = useReducedMotion();
  const wide = useWide();
  const map = useRef<StoryMapHandle>(null);
  const [scene, setScene] = useState(0);
  const [chain, setChainState] = useState<ChainState>(EMPTY_CHAIN);
  const [alertCard, setAlert] = useState<AlertCard | null>(null);
  const generation = useRef(0);
  const heading = useRef<HTMLDivElement>(null);

  const go = useCallback((to: number) => {
    generation.current += 1;
    setAlert(null);
    setScene(to);
  }, []);
  const skip = useCallback(() => {
    map.current?.reset();
    go(LAST);
  }, [go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip]);

  useEffect(() => {
    if (scene > 0) heading.current?.focus();
  }, [scene]);

  useEffect(() => {
    if (!alertCard) return;
    const t = setTimeout(() => setAlert(null), 7000);
    return () => clearTimeout(t);
  }, [alertCard]);

  const stage: Stage = useMemo(() => {
    const mine = generation.current;
    return {
      story,
      evidence,
      map,
      setChain: setChainState,
      alert: setAlert,
      next: () => go(scene + 1),
      alive: () => generation.current === mine,
      reduced,
    };
    // A new stage object per scene, so a sequence started in one scene stops when it's left.
  }, [scene, story, evidence, reduced, go]);

  const panel = useRef<HTMLDivElement>(null);
  const chainBox = useRef<HTMLDivElement>(null);
  const [panelH, setPanelH] = useState(420);
  const [chainH, setChainH] = useState(112);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (panel.current)
        setPanelH(panel.current.getBoundingClientRect().bottom);
      if (chainBox.current)
        setChainH(
          window.innerHeight - chainBox.current.getBoundingClientRect().top,
        );
    });
    if (panel.current) observer.observe(panel.current);
    if (chainBox.current) observer.observe(chainBox.current);
    return () => observer.disconnect();
  }, [scene]);
  const inset = wide
    ? { top: 0, right: 0, bottom: 128, left: 520 }
    : phoneInset(panelH, chainH);

  const restart = () => {
    setChainState(EMPTY_CHAIN);
    map.current?.reset();
    go(1);
  };

  return (
    <main
      id="main"
      className="fixed inset-0 overflow-hidden bg-machine text-machine-ink"
    >
      <StoryMap ref={map} story={story} reducedMotion={reduced} inset={inset} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[401] bg-[linear-gradient(180deg,rgb(14_28_22/0.5)_0%,transparent_45%,transparent_70%,rgb(14_28_22/0.75)_100%)] min-[900px]:bg-[linear-gradient(90deg,rgb(14_28_22/0.94)_0,rgb(14_28_22/0.82)_420px,rgb(14_28_22/0.3)_560px,transparent_760px),linear-gradient(0deg,rgb(14_28_22/0.6)_0,transparent_220px)]"
      />

      <div
        ref={panel}
        className="absolute inset-x-0 top-0 bottom-auto z-[500] flex max-h-[54vh] flex-col rounded-b-3xl bg-machine/95 px-4 pt-4 pb-1 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.7)] min-[900px]:inset-y-7 min-[900px]:right-auto min-[900px]:left-7 min-[900px]:max-h-none min-[900px]:w-[470px] min-[900px]:rounded-none min-[900px]:bg-transparent min-[900px]:p-0 min-[900px]:shadow-none"
      >
        <div className="flex items-center gap-4">
          <Lockup size={24} reading="lime" />
          {scene > 0 && scene < LAST && (
            <span
              className="flex gap-1.5"
              role="img"
              aria-label={`Part ${scene} of ${LAST - 1}`}
            >
              {Array.from({ length: LAST - 1 }, (_, i) => (
                <i
                  key={i}
                  className={cn(
                    "h-[3px] w-6 rounded-full transition-colors duration-500",
                    i < scene ? "bg-lime" : "bg-machine-line",
                  )}
                />
              ))}
            </span>
          )}
        </div>
        <div
          ref={heading}
          tabIndex={-1}
          className="machine-scroll mt-6 flex-1 overflow-y-auto pr-1 pb-4 outline-none"
        >
          {scene === 0 && <Opening stage={stage} />}
          {scene === 1 && <Measure stage={stage} />}
          {scene === 2 && <Fund stage={stage} />}
          {scene === 3 && <Watch stage={stage} />}
          {scene === 4 && <Trust stage={stage} />}
          {scene === LAST && <YourTurn onReplay={restart} />}
        </div>
      </div>

      {scene < LAST && (
        <Button
          variant="ghost"
          className="absolute top-3 right-3 z-[600] h-9 rounded-full bg-machine-raised px-3.5 text-machine-ink hover:bg-machine-line hover:text-machine-ink min-[900px]:top-6 min-[900px]:right-7 min-[900px]:bg-machine/75 min-[900px]:px-4 min-[900px]:backdrop-blur-sm"
          onClick={skip}
        >
          <span className="max-[480px]:sr-only">Skip to your sandbox</span>
          <span aria-hidden="true" className="min-[481px]:hidden">
            Skip
          </span>
          <X aria-hidden="true" />
        </Button>
      )}

      {alertCard && (
        <div
          role="status"
          className="ww-rise absolute right-4 bottom-32 z-[650] w-[min(340px,calc(100vw-2rem))] rounded-2xl bg-card p-4 text-foreground shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)] min-[900px]:top-20 min-[900px]:right-7 min-[900px]:bottom-auto"
        >
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <BellRing className="size-3.5" aria-hidden="true" />
            Alert to {alertCard.to}
          </p>
          <p className="mt-1 font-medium">{alertCard.title}</p>
          <p className="text-sm text-muted-foreground">{alertCard.body}</p>
        </div>
      )}

      {scene > 0 && scene < LAST && (
        <div
          ref={chainBox}
          className="pointer-events-none absolute inset-x-3 bottom-3 z-[500] flex justify-center min-[900px]:bottom-7 min-[900px]:left-[540px]"
        >
          <StoryChain chain={chain} reducedMotion={reduced} />
        </div>
      )}
    </main>
  );
}

/** On a phone the map sits between the story panel and the chain; keep at least `MIN_MAP` px of
 * it for framing the site, else Leaflet would fly to its maximum zoom. */
const MIN_MAP = 160;
function phoneInset(panelBottom: number, chainHeight: number) {
  const height = typeof window === "undefined" ? 844 : window.innerHeight;
  const bottom = Math.max(0, chainHeight);
  const room = height - panelBottom - bottom - 80;
  const top =
    room >= MIN_MAP ? panelBottom : Math.max(0, height - bottom - 80 - MIN_MAP);
  return { top, right: 0, bottom, left: 0 };
}

// ----- building blocks --------------------------------------------------------------------------

function Title({ children }: { children: ReactNode }) {
  return (
    <h1 className="font-serif text-[clamp(2.1rem,3.6vw,3rem)] leading-[1.04] tracking-tight text-balance">
      {children}
    </h1>
  );
}

function Why({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-[42ch] text-[17px] leading-relaxed text-machine-muted">
      {children}
    </p>
  );
}

/** New content in the story panel scrolls itself into view, so the next step is never hidden
 * below the fold of the panel. */
function useArrive<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    ref.current?.scrollIntoView?.({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    });
  }, []);
  return ref;
}

function Actions({ children }: { children: ReactNode }) {
  const ref = useArrive<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 pb-1"
    >
      {children}
    </div>
  );
}

function Primary({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      size="lg"
      onClick={onClick}
      disabled={disabled}
      variant="on-image"
      className="font-semibold focus-visible:ring-card focus-visible:ring-offset-2 focus-visible:ring-offset-machine"
    >
      {children}
    </Button>
  );
}

function Secondary({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      size="lg"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="bg-machine-raised text-machine-ink hover:bg-machine-line hover:text-machine-ink focus-visible:ring-lime"
    >
      {children}
    </Button>
  );
}

function Tag({
  tone = "lime",
  children,
}: {
  tone?: "lime" | "clay";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "font-mono text-xs tracking-wide",
        tone === "lime" ? "text-lime" : "text-clay",
      )}
    >
      {children}
    </span>
  );
}

function Row({
  icon,
  title,
  who,
  tone = "lime",
  children,
}: {
  icon: ReactNode;
  title: string;
  who?: string | null;
  tone?: "lime" | "clay";
  children?: ReactNode;
}) {
  const ref = useArrive<HTMLLIElement>();
  return (
    <li
      ref={ref}
      className="ww-rise grid grid-cols-[2rem_1fr] gap-3 rounded-2xl bg-machine-raised px-3.5 py-3"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-8 place-items-center rounded-lg bg-machine-line",
          tone === "lime" ? "text-lime" : "text-clay",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="leading-snug">
          <b className="font-semibold">{title}</b>
          {who && (
            <span className="ml-2 font-mono text-[11.5px] whitespace-nowrap text-lime">
              {who}
            </span>
          )}
        </p>
        {children && (
          <div className="mt-1 text-[14.5px] leading-relaxed text-machine-muted">
            {children}
          </div>
        )}
      </div>
    </li>
  );
}

function Feed({ children }: { children: ReactNode }) {
  return <ul className="mt-5 grid gap-2.5">{children}</ul>;
}

const pause = (ms: number, s: Stage) =>
  s.reduced ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms));

/** Run a scene's sequence once; `steps` checks `alive()` between moves. */
function useSequence(run: () => Promise<void>, start: boolean) {
  const started = useRef(false);
  useEffect(() => {
    if (!start || started.current) return;
    started.current = true;
    void run();
  }, [run, start]);
}

// ----- the scenes -------------------------------------------------------------------------------

/** Fly to the site (or wait for a flight already under way), then draw its boundary. */
async function arrive(stage: Stage) {
  await stage.map.current?.flyToSite();
  if (stage.alive()) await stage.map.current?.drawBoundary();
}

function Opening({ stage }: { stage: Stage }) {
  const { story } = stage;
  const run = useCallback(() => arrive(stage), [stage]);
  useSequence(run, true);
  const area = Math.round(Number(story.site.area_ha));
  return (
    <>
      <Title>
        This wetland is alive. Keeping it that way pays its community nothing.
      </Title>
      <p className="mt-5 max-w-[40ch] text-[19px] leading-relaxed">
        {area} hectares in {story.site.place}, looked after by its community.
        The only real offer they get is to sell it.
      </p>
      <Why>WildWorth gives them a better one.</Why>
      <Actions>
        <Primary onClick={stage.next}>
          Show me how
          <ArrowRight aria-hidden="true" />
        </Primary>
      </Actions>
    </>
  );
}

function Measure({ stage }: { stage: Stage }) {
  const { story, evidence, map } = stage;
  const { baseline } = storyRatings(story);
  const [step, setStep] = useState(0);
  const [visionDone, setVisionDone] = useState(false);
  const run = useCallback(async () => {
    const s = stage;
    const at = (n: number) => s.alive() && (setStep(n), true);
    await arrive(stage);
    if (!at(1)) return;
    await pause(1400, s);
    if (!at(2)) return;
    await map.current?.revealLandCover();
    await pause(700, s);
    if (!at(3)) return;
    await pause(1900, s);
    map.current?.hideLandCover();
    if (!at(4)) return;
    await map.current?.sweepViews();
    if (!s.alive()) return;
    setVisionDone(true);
    await pause(900, s);
    if (!at(5)) return;
    await pause(1300, s);
    s.setChain((c) => ({ ...c, health: { value: health(baseline.health) } }));
    await pause(700, s);
    s.setChain((c) => ({ ...c, grade: baseline.grade as Grade }));
    await pause(500, s);
    at(6);
  }, [stage, map, baseline]);
  // A visitor who moved on mid-flight sees the boundary as soon as the map lands.
  const land = useCallback(() => arrive(stage), [stage]);
  useSequence(land, true);
  useSequence(run, step > 0);

  const cover = baseline.landcover;
  const legend = Object.entries(story.images.legend)
    .map(([key, l]) => ({ key, ...l, share: cover[key] ?? 0 }))
    .filter((l) => l.share >= 0.02)
    .sort((a, b) => b.share - a.share);
  const ndvi = story.land.ndvi.map((p) => p.ndvi ?? 0);

  return (
    <>
      <Title>First, measure what the land is worth alive.</Title>
      <Why>
        Nobody pays for what nobody can measure. AI agents study the wetland
        from space and from local news, and tested code turns what they find
        into numbers.
      </Why>
      {step === 0 && (
        <Actions>
          <Primary onClick={() => setStep(1)}>Watch it being rated</Primary>
        </Actions>
      )}
      {step > 0 && (
        <p className="mt-4 text-sm text-machine-muted">
          A real rating of this wetland
          {evidence ? `, recorded ${date(evidence.recordedOn)}` : ""}. In your
          sandbox it runs live.
        </p>
      )}
      <Feed>
        {step >= 1 && (
          <Row
            icon={<BrainCircuit className="size-4" />}
            title="Plans the work"
            who={evidence?.planner}
          >
            Satellite data first, then local news to explain any change.
          </Row>
        )}
        {step >= 2 && (
          <Row
            icon={<Satellite className="size-4" />}
            title="Reads five years of satellite data"
            who="Earth Engine"
          >
            <p>
              {share(baseline.natural_fraction)} of the land is natural cover.
              Open water: {story.land.water_change > 0 ? "+" : "−"}
              {Math.abs(story.land.water_change).toFixed(1)}% over five years.
            </p>
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
              {legend.map((l) => (
                <li key={l.key} className="flex items-center gap-1.5">
                  <i
                    aria-hidden="true"
                    className="size-2.5 rounded-[3px]"
                    style={{ background: l.color }}
                  />
                  {l.label} {share(l.share)}
                </li>
              ))}
            </ul>
            <svg
              viewBox="0 0 300 40"
              preserveAspectRatio="none"
              className="mt-2 h-10 w-full"
              role="img"
              aria-label={`Monthly greenness (NDVI), ${ndvi.length} months`}
            >
              <polyline
                points={sparkline(ndvi, 300, 40)}
                fill="none"
                className="stroke-lime"
                strokeWidth={1.6}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </Row>
        )}
        {step >= 3 && (
          <Row
            icon={<Newspaper className="size-4" />}
            title="Finds what's happening on the ground"
            who={evidence?.scout ? `${evidence.scout} · Tavily` : "Tavily"}
          >
            {evidence?.news.length ? (
              <ul className="mt-1 grid gap-1.5">
                {evidence.news.map((n) => (
                  <li
                    key={n.url ?? n.title}
                    className="border-t border-machine-line pt-1.5 first:border-0 first:pt-0"
                  >
                    <span className="text-machine-ink">{n.title}</span>
                    {n.host && (
                      <span className="block font-mono text-[11px]">
                        {n.host}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              "Searches local news in the site's own language."
            )}
          </Row>
        )}
        {step >= 4 && (
          <Row
            icon={<Eye className="size-4" />}
            title="Compares the land five years apart"
            who={evidence?.vision?.model}
          >
            {visionDone
              ? `${evidence?.vision?.reading ?? "Looks for clearing, water loss or regrowth."} Code checks it against the satellite numbers.`
              : "Looking at the two views…"}
          </Row>
        )}
        {step >= 5 && (
          <Row
            icon={<Scale className="size-4" />}
            title="Weighs all the evidence"
            who={evidence?.auditor?.model}
          >
            {evidence?.auditor ? (
              <>
                <q className="text-machine-ink">{evidence.auditor.verdict}</q>
                {evidence.citations != null && (
                  <span className="mt-1 block">
                    {evidence.citations} citations, each checked by code.
                  </span>
                )}
              </>
            ) : (
              "Every claim must cite its source."
            )}
          </Row>
        )}
      </Feed>
      {step >= 6 && (
        <>
          <div className="ww-rise mt-4 rounded-2xl bg-card p-4 text-foreground">
            <p className="font-serif text-[1.7rem] leading-tight">
              Healthy, and worth keeping.
            </p>
            <p className="mt-1.5 text-[15px]">
              Worth <b>{valueRange(baseline.value_low, baseline.value_high)}</b>{" "}
              to people as it is: clean water, carbon, flood protection and
              habitat. Confidence {Number(baseline.confidence).toFixed(0)}%.
            </p>
          </div>
          <Actions>
            <Primary onClick={stage.next}>
              Now let people back it
              <ArrowRight aria-hidden="true" />
            </Primary>
          </Actions>
        </>
      )}
    </>
  );
}

function Fund({ stage }: { stage: Stage }) {
  const { story, map } = stage;
  const { market } = story;
  const [backed, setBacked] = useState(false);
  const run = useCallback(async () => {
    map.current?.hideViews();
    await pause(900, stage);
    if (!stage.alive()) return;
    stage.setChain((c) => ({ ...c, price: { value: market.opening_price } }));
  }, [map, stage, market.opening_price]);
  useSequence(run, true);
  return (
    <>
      <Title>Then let people fund it, without buying the land.</Title>
      <Why>
        A rating people can trust sets a fair price. Supporters back the wetland
        at that price, and their money goes to the community that keeps it
        alive.
      </Why>
      <Feed>
        <Row
          icon={<Users className="size-4" />}
          title="Rosa opens her land to supporters"
          who="Rosa · steward"
        >
          At the rating&apos;s fair price, {dollars(market.opening_price)} a
          unit. Her community keeps {Number(market.retained_pct).toFixed(0)}% of
          the stake.
        </Row>
        {backed && (
          <Row
            icon={<HandCoins className="size-4" />}
            title="Arjun backs the wetland"
            who="Arjun · supporter"
          >
            He pays {dollars(market.backing.paid)} for {market.backing.units}{" "}
            units. All of it reaches the community&apos;s fund, and they still
            own every hectare.
          </Row>
        )}
      </Feed>
      {!backed ? (
        <Actions>
          <Primary
            onClick={() => {
              setBacked(true);
              stage.setChain((c) => ({
                ...c,
                fund: Number(market.backing.to_community),
              }));
            }}
          >
            Back it as Arjun · {market.backing.units} units
          </Primary>
        </Actions>
      ) : (
        <>
          <p className="mt-4 text-sm text-machine-muted">
            Play money only. Nothing here is a real investment.
          </p>
          <Actions>
            <Primary onClick={stage.next}>
              But why would Arjun care?
              <ArrowRight aria-hidden="true" />
            </Primary>
          </Actions>
        </>
      )}
    </>
  );
}

function Watch({ stage }: { stage: Stage }) {
  const { story, map } = stage;
  const { baseline, damaged, restored } = storyRatings(story);
  const { market } = story;
  const [step, setStep] = useState(0);

  const damage = async () => {
    setStep(1);
    await map.current?.markNorthEdge("damaged");
    if (!stage.alive()) return;
    setStep(2);
    await pause(1300, stage);
    if (!stage.alive()) return;
    setStep(3);
    stage.setChain((c) => ({
      ...c,
      health: {
        value: health(damaged.health),
        delta: `−${(Number(baseline.health) - Number(damaged.health)).toFixed(1)}`,
      },
    }));
    await pause(600, stage);
    stage.setChain((c) => ({ ...c, grade: damaged.grade as Grade }));
    await pause(500, stage);
    stage.setChain((c) => ({
      ...c,
      price: {
        value: market.price_after_downgrade,
        delta: change(market.opening_price, market.price_after_downgrade),
      },
    }));
    stage.alert({
      to: "Arjun",
      title: `${story.site.name} downgraded to ${damaged.grade}`,
      body: `Your stake moved ${change(market.opening_price, market.price_after_downgrade)}. See the evidence behind it.`,
    });
    await pause(900, stage);
    if (stage.alive()) setStep(4);
  };

  const restore = async () => {
    setStep(5);
    await map.current?.markNorthEdge("restored");
    if (!stage.alive()) return;
    setStep(6);
    stage.setChain((c) => ({
      ...c,
      health: {
        value: health(restored.health),
        delta: `+${(Number(restored.health) - Number(damaged.health)).toFixed(1)}`,
      },
    }));
    await pause(600, stage);
    stage.setChain((c) => ({ ...c, grade: restored.grade as Grade }));
    await pause(500, stage);
    stage.setChain((c) => ({
      ...c,
      price: {
        value: market.price_after_restoration,
        delta: change(
          market.price_after_downgrade,
          market.price_after_restoration,
        ),
      },
    }));
    stage.alert({
      to: "Arjun",
      title: `${story.site.name} upgraded to ${restored.grade}`,
      body: "The restoration shows up in the satellite data.",
    });
    await pause(700, stage);
    if (stage.alive()) setStep(7);
  };

  const built = (r: typeof baseline) => share(r.landcover.built ?? 0);
  const water = (r: typeof baseline) => share(r.landcover.water ?? 0);

  return (
    <>
      <Title>Because his stake moves with the land.</Title>
      <Why>
        If the wetland is damaged, Arjun&apos;s stake falls. If it recovers, it
        rises. So the supporter and the community want the same thing, and
        WildWatch keeps watching.
      </Why>
      {step === 0 && (
        <Actions>
          <Secondary onClick={() => void damage()}>
            <TriangleAlert aria-hidden="true" />
            Simulate damage on the north edge
          </Secondary>
          <Tag tone="clay">Simulated</Tag>
        </Actions>
      )}
      <Feed>
        {step >= 2 && (
          <Row
            icon={<Satellite className="size-4" />}
            title="The next satellite pass sees it"
            who="Earth Engine · simulated"
            tone="clay"
          >
            Built-up land {built(baseline)} → {built(damaged)}. Open water{" "}
            {water(baseline)} → {water(damaged)}.
          </Row>
        )}
        {step >= 3 && (
          <Row
            icon={<Scale className="size-4" />}
            title="The rating follows the land"
            tone="clay"
          >
            Health {health(baseline.health)} → {health(damaged.health)}: the
            formula moves it to {damaged.grade}, and the price follows.
          </Row>
        )}
        {step >= 4 && (
          <Row
            icon={<Sprout className="size-4" />}
            title="Rosa sees what to fix"
            who="Rosa · steward"
          >
            What changed, where, and what would bring the rating back.
          </Row>
        )}
        {step >= 6 && (
          <Row
            icon={<Sprout className="size-4" />}
            title="The land recovers"
            who="Earth Engine · simulated"
          >
            Built-up land falls to {built(restored)}; trees and wetland plants
            grow back. Health {health(restored.health)}: {restored.grade}.
          </Row>
        )}
      </Feed>
      {step === 4 && (
        <Actions>
          <Secondary onClick={() => void restore()}>
            <Sprout aria-hidden="true" />
            Simulate the restoration
          </Secondary>
          <Tag tone="clay">Simulated</Tag>
        </Actions>
      )}
      {step >= 7 && (
        <>
          <p className="ww-rise mt-4 text-[15px] text-machine-ink">
            Damaging the land cost Arjun. Restoring it paid both of them.
            That&apos;s the whole idea.
          </p>
          <Actions>
            <Primary onClick={stage.next}>
              But can anyone trust these ratings?
              <ArrowRight aria-hidden="true" />
            </Primary>
          </Actions>
        </>
      )}
    </>
  );
}

function Trust({ stage }: { stage: Stage }) {
  const { ledger } = stage.story;
  const [tampered, setTampered] = useState(false);
  useEffect(() => {
    void stage.map.current?.markNorthEdge(null);
  }, [stage.map]);
  const broken = ledger.broken_at;
  return (
    <>
      <Title>And nobody can quietly change the record.</Title>
      <Why>
        Real support now rides on these ratings, so no one, WildWorth included,
        can rewrite one afterwards. Each entry is sealed with the fingerprint of
        the one before it.
      </Why>
      <ol className="mt-5 grid gap-2" aria-label="The Record">
        {ledger.entries.map((e) => {
          const edited = tampered && e.seq === ledger.tampered_seq;
          const after = tampered && broken !== null && e.seq > broken;
          return (
            <li
              key={e.seq}
              className={cn(
                "grid grid-cols-[1fr_auto] items-center gap-x-3 rounded-xl px-3.5 py-2.5 text-[14.5px] transition-[background-color,opacity] duration-500",
                edited ? "bg-clay/25" : "bg-machine-raised",
                after && "opacity-50",
              )}
            >
              <span>
                {edited
                  ? e.label.replace(ledger.tampered_from, ledger.tampered_to)
                  : e.label}
              </span>
              <span className="font-mono text-[11px] text-machine-muted">
                {e.hash.slice(0, 4)}…{e.hash.slice(-4)}
              </span>
            </li>
          );
        })}
      </ol>
      <p
        className={cn(
          "mt-3 flex items-center gap-2.5 font-medium",
          tampered ? "text-clay" : "text-machine-ink",
        )}
      >
        {tampered && !ledger.tampered_verified ? (
          <>
            <ShieldAlert className="size-5 shrink-0" aria-hidden="true" />
            Tampering detected at entry {(broken ?? 0) + 1}: its fingerprint no
            longer matches.
          </>
        ) : (
          <>
            <ShieldCheck
              className="size-5 shrink-0 text-lime"
              aria-hidden="true"
            />
            {ledger.verified
              ? "Record verified: every fingerprint matches."
              : "Record check failed."}
          </>
        )}
      </p>
      {!tampered ? (
        <Actions>
          <Secondary onClick={() => setTampered(true)}>
            Try to turn the {ledger.tampered_from} into an {ledger.tampered_to}
          </Secondary>
        </Actions>
      ) : (
        <>
          <p className="mt-3 text-sm text-machine-muted">
            The real Record works the same way: anyone can verify any
            site&apos;s history, any time.
          </p>
          <Actions>
            <Primary onClick={stage.next}>
              Now try it yourself
              <ArrowRight aria-hidden="true" />
            </Primary>
          </Actions>
        </>
      )}
    </>
  );
}

function YourTurn({ onReplay }: { onReplay: () => void }) {
  const sandbox = useOpenSandbox();
  const busy = sandbox.busy === LOOK_AROUND.key;
  return (
    <>
      <Title>Your turn. Everything here is live.</Title>
      <Why>
        Your own private WildWorth, with a community steward, a supporter and
        the WildWorth team in it. Switch between them any time. No sign-up, play
        money only.
      </Why>
      <Actions>
        <Primary
          onClick={() => void sandbox.open(LOOK_AROUND)}
          disabled={sandbox.busy !== null}
        >
          {busy ? <Spinner aria-hidden="true" /> : null}
          Open my sandbox
          {!busy && <ArrowRight aria-hidden="true" />}
        </Primary>
        <Button
          variant="link"
          className="h-auto px-0 text-machine-muted hover:text-machine-ink"
          onClick={onReplay}
        >
          Watch the story again
        </Button>
      </Actions>
      {sandbox.error?.key === LOOK_AROUND.key && (
        <p role="alert" className="mt-2 text-sm text-clay">
          {sandbox.error.text}
        </p>
      )}
      <h2 className="mt-8 mb-3 text-sm font-medium text-machine-muted">
        Or start from any step of the loop
      </h2>
      <SandboxFlow sandbox={sandbox} />
    </>
  );
}
