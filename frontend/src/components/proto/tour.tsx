"use client";

import { Cog, Lightbulb, Wand2, X } from "lucide-react";
import Link from "@/components/app-link";
import { usePathname, useRouter } from "@/lib/nav";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "cn";

import { LiveBadge } from "@/components/proto/bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePrototype } from "@/lib/prototype/store";
import { siteDataFor } from "@/lib/prototype/data";
import {
  HERO_ID,
  isFreshWorld,
  launchOffer,
  rateDraft,
  registerCommunity,
  updateDraft,
  type PersonaKey,
  type World,
} from "@/lib/prototype/world";

type Ctx = ReturnType<typeof usePrototype> & {
  router: ReturnType<typeof useRouter>;
};

type TourStep = {
  chapter: number;
  chapterTitle: string;
  title: string;
  why: string;
  tech: string;
  route: string;
  persona: PersonaKey;
  target?: string;
  live?: boolean;
  doLabel?: string;
  doIt?: (ctx: Ctx) => void;
  /** Brings the sandbox to the state this step needs, so skipping ahead never dead-ends. */
  onEnter?: (w: World) => World;
};

const SAVED_BOUNDARY = siteDataFor("wetland_mx").polygon.slice(0, -1);

function ensureCommunity(w: World) {
  return w.community.registered ? w : registerCommunity(w, w.community.name);
}

function ensureStep(n: number) {
  return (w: World) => {
    const site = w.sites.find((s) => s.id === HERO_ID);
    if (site?.reports.length) return ensureCommunity(w);
    const withShape =
      w.draft.polygon.length >= 3 || n < 2
        ? w
        : updateDraft(w, { polygon: SAVED_BOUNDARY });
    return updateDraft(ensureCommunity(withShape), {
      step: Math.max(Math.min(w.draft.step, n), n),
    });
  };
}

function ensureRated(w: World) {
  const site = w.sites.find((s) => s.id === HERO_ID);
  if (site?.reports.length) return w;
  return rateDraft(ensureStep(3)(w));
}

function ensureListed(w: World) {
  const rated = ensureRated(w);
  const site = rated.sites.find((s) => s.id === HERO_ID);
  return site?.status === "listed"
    ? rated
    : launchOffer(rated, rated.draft.retainedPct);
}

function clickTarget(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
  el?.click();
}

export const TOUR_STEPS: TourStep[] = [
  {
    chapter: 1,
    chapterTitle: "Register",
    title: "Meet Rosa's cooperative",
    why: "Rosa's cooperative protects a wetland beside an industrial zone. Until now its only big offer was to sell the land.",
    tech: "Each community gets an owner and a treasury account. Demo personas have no password and live in your private sandbox (ADR-0005).",
    route: "/steward",
    persona: "steward",
    target: "community-form",
    doLabel: "Register the community",
    doIt: (c) => c.act((w) => registerCommunity(w, w.community.name)),
  },
  {
    chapter: 2,
    chapterTitle: "List the land",
    title: "Draw the boundary",
    why: "The community draws the land it protects. No surveyors, no consultants.",
    tech: "Area uses an equal-area method; the shape is checked for self-intersection, 10–50,000 ha and overlap with other listings (T36).",
    route: "/steward/list",
    persona: "steward",
    target: "draw-map",
    onEnter: (w) => {
      const site = w.sites.find((s) => s.id === HERO_ID);
      return site?.reports.length
        ? w
        : updateDraft(ensureCommunity(w), { step: 1 });
    },
    doLabel: "Draw Rosa's saved boundary",
    doIt: () => clickTarget("use-saved-boundary"),
  },
  {
    chapter: 3,
    chapterTitle: "AI rates it",
    title: "Run the rating",
    why: "In minutes, the site gets what used to take months: a value, a grade and an honest confidence score.",
    tech: "Nemotron 3 Super plans the run and calls tools: satellite metrics, valuation, News Scout (Tavily + Nemotron 3 Nano), then Nemotron 3 Ultra audits.",
    route: "/steward/list",
    persona: "steward",
    target: "rate-button",
    onEnter: ensureStep(3),
    live: true,
    doLabel: "Start the rating",
    doIt: () => clickTarget("rate-button"),
  },
  {
    chapter: 3,
    chapterTitle: "AI rates it",
    title: "Read the report card",
    why: "Every number shows its range and confidence. The grade describes the land's health, not a return.",
    tech: "Health, grade and value come from tested formulas (dev-spec §7.4). The Auditor may only adjust health within ±10, citing evidence.",
    route: "/steward/list",
    persona: "steward",
    target: "report-card",
    onEnter: ensureRated,
  },
  {
    chapter: 4,
    chapterTitle: "Opening offer",
    title: "Open the site to supporters",
    why: "The community keeps the majority stake and the land. Supporters fund it by taking play-money stakes.",
    tech: "Opening price = fair value per unit from the formula shown, step by step (dev-spec §8). Proceeds go to the community fund.",
    route: "/steward/list",
    persona: "steward",
    target: "offer-panel",
    onEnter: ensureRated,
    doLabel: "Launch the opening offer",
    doIt: () => clickTarget("launch-offer"),
  },
  {
    chapter: 5,
    chapterTitle: "Invest",
    title: "Arjun backs the wetland",
    why: "An impact investor can compare rated sites and back one in a click.",
    tech: "Instant fill with slippage; the first units come from the primary offer, so the money goes straight to the community.",
    route: `/asset/${HERO_ID}`,
    persona: "investor",
    target: "trade-panel",
    onEnter: ensureListed,
    doLabel: "Take 100 units",
    doIt: (c) => {
      const result = c.placeOrder("investor", HERO_ID, "buy", 100);
      if (!result.ok) clickTarget("trade-submit");
    },
  },
  {
    chapter: 5,
    chapterTitle: "Invest",
    title: "Funded without selling",
    why: "Arjun's play money goes down; Rosa's community fund goes up by the same primary amount. The land stays with the cooperative.",
    tech: "Primary units credit `community_wallet` in the same transaction as the order (T16, T17).",
    route: `/asset/${HERO_ID}`,
    persona: "investor",
    target: "trade-receipt",
  },
  {
    chapter: 6,
    chapterTitle: "Time passes",
    title: "Move to the next quarter",
    why: "Ratings don't stand still. New satellite data arrives every quarter.",
    tech: "Re-rating replays the cached Time Machine scenarios (T13): restoration first, with a short live Auditor call.",
    route: "/admin",
    persona: "admin",
    target: "next-quarter",
    live: true,
    doLabel: "Next quarter",
    doIt: () => clickTarget("next-quarter"),
  },
  {
    chapter: 7,
    chapterTitle: "Bad news",
    title: "Inject an encroachment",
    why: "When a factory fills the wetland's edge, supporters hear about it immediately and the price reflects it.",
    tech: "The encroachment scenario moves land cover to built-up and drains water; News Scout finds the report; the Auditor cites both.",
    route: "/admin",
    persona: "admin",
    target: "inject-encroachment",
    live: true,
    doLabel: "Inject encroachment",
    doIt: () => clickTarget("inject-encroachment"),
  },
  {
    chapter: 7,
    chapterTitle: "Bad news",
    title: "Rosa gets a Recovery plan",
    why: "The community isn't just punished: it gets concrete, local steps to recover the rating.",
    tech: "Recommendations come with each report version; grade changes create alerts for owners and holders.",
    route: "/steward",
    persona: "steward",
    target: "stewardship-actions",
  },
  {
    chapter: 8,
    chapterTitle: "Ask why",
    title: "Ask Bea",
    why: "Arjun asks in plain words and gets an answer that cites the report and the news.",
    tech: "Nemotron 3 Nano with retrieval over reports and events; every answer links its sources.",
    route: `/asset/${HERO_ID}`,
    persona: "investor",
    target: "copilot-button",
    live: true,
    doLabel: "Ask “Why did it drop?”",
    doIt: (c) => {
      c.openCopilot(HERO_ID);
      c.ask("Why did it drop?", HERO_ID);
    },
  },
  {
    chapter: 9,
    chapterTitle: "Trust",
    title: "Verify the Record",
    why: "Every listing, rating and price anchor is written to a tamper-evident record anyone can check.",
    tech: "Each entry stores sha256(payload + kind + seq + previous hash). Verifying recomputes the whole chain in your browser.",
    route: `/asset/${HERO_ID}?tab=ledger`,
    persona: "investor",
    target: "ledger-verify",
    doLabel: "Verify the chain",
    doIt: () => clickTarget("ledger-verify"),
  },
  {
    chapter: 9,
    chapterTitle: "Trust",
    title: "Now tamper with it",
    why: "Change one old rating and the record exposes it at once.",
    tech: "The tamper demo edits a stored report's health without re-hashing. Sandbox only, never the live world.",
    route: `/asset/${HERO_ID}?tab=ledger`,
    persona: "investor",
    target: "ledger-tamper",
    doLabel: "Tamper and re-verify",
    doIt: () => {
      clickTarget("ledger-tamper");
      window.setTimeout(() => clickTarget("ledger-verify"), 400);
    },
  },
  {
    chapter: 10,
    chapterTitle: "Under the hood",
    title: "Open the Agent Trace",
    why: "Every site shows how the AI rated it, so judges can see exactly how Nemotron is used, step by step.",
    tech: "Every model call is logged with model, tokens, latency and cost, and counts against the LLM budget. The AI at work page shows them all.",
    route: `/asset/${HERO_ID}`,
    persona: "investor",
    target: "trace-button",
    onEnter: ensureListed,
    doLabel: "Open the trace",
    doIt: () => clickTarget("trace-button"),
  },
];

const CHAPTERS = 10;
const STORAGE = "nx-prototype-tour";

type TourApi = {
  active: boolean;
  index: number;
  finished: boolean;
  start: () => void;
  stop: () => void;
  go: (i: number) => void;
};

const TourCtx = createContext<TourApi | null>(null);

export function useTour() {
  const ctx = useContext(TourCtx);
  if (!ctx) throw new Error("useTour must be used inside <TourProvider>");
  return ctx;
}

export function TourProvider({ children }: { children: ReactNode }) {
  const store = usePrototype();
  const router = useRouter();
  const [state, setState] = useState({
    active: false,
    index: 0,
    finished: false,
  });

  const [resumeAt, setResumeAt] = useState<number | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE);
      const saved = raw
        ? (JSON.parse(raw) as { active?: boolean; index?: number })
        : null;
      if (saved?.active && typeof saved.index === "number")
        setResumeAt(saved.index);
    } catch {
      // Storage blocked: the tour simply starts fresh.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE,
        JSON.stringify({ active: state.active, index: state.index }),
      );
    } catch {
      // Ignore.
    }
  }, [state.active, state.index]);

  const go = useCallback(
    (i: number) => {
      if (i >= TOUR_STEPS.length) {
        setState({ active: false, index: 0, finished: true });
        return;
      }
      const step = TOUR_STEPS[Math.max(0, i)];
      if (step.onEnter) store.act(step.onEnter);
      store.setPersona(step.persona);
      if (step.target !== "trace-button") store.closeTrace();
      if (step.target !== "copilot-button") store.closeCopilot();
      router.push(step.route);
      setState({ active: true, index: Math.max(0, i), finished: false });
    },
    [router, store],
  );

  // Resume an unfinished tour after a reload, once the sandbox world has loaded from storage,
  // so the step's page and state are restored too.
  useEffect(() => {
    if (resumeAt === null || !store.hydrated) return;
    setResumeAt(null);
    go(Math.min(resumeAt, TOUR_STEPS.length - 1));
  }, [resumeAt, store.hydrated, go]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const beginFresh = useCallback(() => {
    setConfirmOpen(false);
    store.reset();
    window.setTimeout(() => go(0), 30);
  }, [store, go]);

  const api = useMemo<TourApi>(
    () => ({
      ...state,
      start: () => {
        // The tour needs the starting world; ask before discarding the visitor's changes.
        if (isFreshWorld(store.world)) beginFresh();
        else setConfirmOpen(true);
      },
      stop: () => setState({ active: false, index: 0, finished: false }),
      go,
    }),
    [state, go, store, beginFresh],
  );

  return (
    <TourCtx.Provider value={api}>
      {children}
      {state.active && (
        <TourOverlay
          step={TOUR_STEPS[state.index]}
          index={state.index}
          ctx={{ ...store, router }}
        />
      )}
      <TourFinish
        open={state.finished}
        onClose={() => setState((s) => ({ ...s, finished: false }))}
        onRestart={() => api.start()}
      />
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle>Start the tour from a fresh sandbox?</DialogTitle>
            <DialogDescription>
              The tour starts from the beginning of the story, so your listings,
              stakes and Time Machine changes will be reset. You stay on the
              same persona.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Keep my demo
            </Button>
            <Button onClick={beginFresh}>Reset and start the tour</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TourCtx.Provider>
  );
}

function useTargetRect(target: string | undefined, key: string) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    setRect(null);
    if (!target) return;
    let frame = 0;
    let tries = 0;
    let el: HTMLElement | null = null;
    const measure = () => {
      if (!el || !document.body.contains(el))
        el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev &&
          Math.abs(prev.top - r.top) < 0.5 &&
          Math.abs(prev.left - r.left) < 0.5 &&
          Math.abs(prev.height - r.height) < 0.5 &&
          Math.abs(prev.width - r.width) < 0.5
            ? prev
            : r,
        );
      }
      tries += 1;
      frame = window.requestAnimationFrame(measure);
    };
    const first = window.setTimeout(() => {
      const found = document.querySelector<HTMLElement>(
        `[data-tour="${target}"]`,
      );
      found?.scrollIntoView({ block: "center", behavior: "smooth" });
      measure();
    }, 350);
    return () => {
      window.clearTimeout(first);
      window.cancelAnimationFrame(frame);
      void tries;
    };
  }, [target, key]);
  return rect;
}

function TourOverlay({
  step,
  index,
  ctx,
}: {
  step: TourStep;
  index: number;
  ctx: Ctx;
}) {
  const tour = useTour();
  const pathname = usePathname();
  const measured = useTargetRect(step.target, `${index}-${pathname}`);
  // With a side panel open, the step's target sits behind it: park the card on the left instead.
  const sheetOpen = ctx.ui.traceOpen || ctx.ui.copilotOpen;
  const rect = sheetOpen ? null : measured;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(400, vw - 24);
  let cardStyle: React.CSSProperties = sheetOpen
    ? { left: 24, bottom: 24, width: cardW }
    : { left: 16, bottom: 16, width: cardW };
  if (rect && vw >= 640) {
    const below = vh - rect.bottom;
    const left = Math.min(Math.max(12, rect.left), vw - cardW - 12);
    const top = Math.max(12, Math.min(rect.top, vh - 340));
    if (rect.right + cardW + 32 < vw && rect.width < vw * 0.45)
      cardStyle = { top, left: rect.right + pad + 16, width: cardW };
    else if (below > 300)
      cardStyle = { top: rect.bottom + pad + 10, left, width: cardW };
    else if (rect.top > 300)
      cardStyle = { bottom: vh - rect.top + pad + 10, left, width: cardW };
    else if (rect.left > cardW + 40)
      cardStyle = {
        top: Math.max(12, Math.min(rect.top, vh - 340)),
        left: rect.left - cardW - 20,
        width: cardW,
      };
    else cardStyle = { bottom: 16, right: 16, width: cardW };
  } else if (vw < 640) {
    cardStyle = { left: 12, right: 12, bottom: 12 };
  }

  return createPortal(
    <>
      <svg
        className="pointer-events-none fixed inset-0 z-[60] h-full w-full"
        aria-hidden="true"
      >
        <defs>
          <mask id="nx-tour-mask">
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - pad}
                y={rect.top - pad}
                width={rect.width + pad * 2}
                height={rect.height + pad * 2}
                rx={20}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="oklch(0.2 0.03 155 / 0.42)"
          mask="url(#nx-tour-mask)"
        />
        {rect && (
          <rect
            x={rect.left - pad}
            y={rect.top - pad}
            width={rect.width + pad * 2}
            height={rect.height + pad * 2}
            rx={20}
            fill="none"
            stroke="var(--lime)"
            strokeWidth={2}
          />
        )}
      </svg>
      <div
        data-tour-card
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        className="nx-rise fixed z-[70] rounded-[1.6rem] bg-card p-5 shadow-lift ring-1 ring-border"
        style={cardStyle}
      >
        <div className="flex items-center gap-3">
          <div className="flex flex-1 gap-1" aria-hidden="true">
            {Array.from({ length: CHAPTERS }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  i + 1 < step.chapter
                    ? "bg-primary"
                    : i + 1 === step.chapter
                      ? "bg-lime-ink"
                      : "bg-foreground/10",
                )}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={tour.stop}
            className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Skip tour"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            Chapter {step.chapter} of {CHAPTERS} · {step.chapterTitle}
          </span>
          {step.live && <LiveBadge />}
        </div>
        <h2 id="tour-title" className="mt-1 font-serif text-2xl leading-tight">
          {step.title}
        </h2>
        <div className="mt-3 space-y-2.5 text-sm">
          <p className="flex gap-2">
            <Lightbulb
              className="mt-0.5 size-4 shrink-0 text-lime-ink"
              aria-hidden="true"
            />
            <span>
              <span className="sr-only">Why this matters: </span>
              {step.why}
            </span>
          </p>
          <p className="flex gap-2 text-muted-foreground">
            <Cog className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="sr-only">Tech behind it: </span>
              {step.tech}
            </span>
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => tour.go(index - 1)}
            disabled={index === 0}
          >
            Back
          </Button>
          <div className="ml-auto flex gap-2">
            {step.doIt && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => step.doIt?.(ctx)}
              >
                <Wand2 aria-hidden="true" />
                {step.doLabel ?? "Do it for me"}
              </Button>
            )}
            <Button size="sm" onClick={() => tour.go(index + 1)}>
              {index === TOUR_STEPS.length - 1 ? "Finish" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

function TourFinish({
  open,
  onClose,
  onRestart,
}: {
  open: boolean;
  onClose: () => void;
  onRestart: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-[1.75rem] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-3xl font-normal">
            What you just saw
          </DialogTitle>
          <DialogDescription>
            Five things WildWorth does, in about seven minutes.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-3 text-sm">
          {[
            [
              "A community listed its land",
              "and kept it: funding came from play-money stakes, not a sale.",
            ],
            [
              "Nemotron agents rated it",
              "from satellite data and local news, with ranges and confidence.",
            ],
            [
              "Supporters backed it",
              "and the community fund grew with every primary unit.",
            ],
            [
              "The rating kept watching",
              "restoration lifted it; encroachment cut it, and holders were alerted.",
            ],
            [
              "Everything is checkable",
              "Bea cites sources, the Record exposes tampering, the trace shows every model call.",
            ],
          ].map(([a, b], i) => (
            <li key={a} className="flex gap-3">
              <span className="tabular grid size-6 shrink-0 place-items-center rounded-full bg-lime text-xs font-semibold text-foreground">
                {i + 1}
              </span>
              <span>
                <span className="font-medium">{a}</span> {b}
              </span>
            </li>
          ))}
        </ol>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={onRestart}>
            Restart the tour
          </Button>
          <Button asChild onClick={onClose}>
            <Link href="/">Explore freely</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
