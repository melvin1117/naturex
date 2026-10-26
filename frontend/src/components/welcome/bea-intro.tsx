"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  BODY_CENTRE_Y,
  flightPose,
  planFlight,
  type Box,
} from "@/lib/bea-flight";

type Phase = "pending" | "writing" | "flying" | "landing" | "hello" | "done";

/** Once per page load: coming back to the welcome from inside the app shows its last frame. */
let playedThisLoad = false;

/** globals.css shows everything at 3.5 s if the script never runs; too late to start then. */
const LATE_MS = 3000;
const LAND_MS = 700;
const HELLO_MS = 4200;
const DOT_EVERY_MS = 45;
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const ALL_WRITTEN = "300vw";

/**
 * The welcome's first moment (brand: "every animation means something"): Bea flies in from the
 * left, the greeting is written where she passes, and she lands in the Ask Bea button, which
 * grows out of her. It shows who she is and where to find her, with no extra words.
 *
 * Mark the parts inside `children`: `data-intro-write` (the headline she writes),
 * `data-intro-rise="1|2"` (what rises once it's written) and `data-intro-land` (the Ask Bea
 * button's wrapper; `data-intro-hello` inside it greets once she's landed). Any key, click,
 * scroll or resize ends it at its last frame. Under reduced motion it never plays.
 */
export function BeaIntro({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const flier = useRef<HTMLDivElement>(null);
  const trail = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("pending");

  useLayoutEffect(() => {
    const scope = root.current;
    const bea = flier.current;
    const dots = trail.current;
    if (playedThisLoad || prefersReducedMotion()) {
      setPhase("done");
      return;
    }
    if (!scope || !bea || !dots || performance.now() > LATE_MS) {
      playedThisLoad = true;
      setPhase("done");
      return;
    }
    return play(scope, bea, dots, setPhase, () => {
      playedThisLoad = true;
    });
  }, []);

  const flying = phase !== "hello" && phase !== "done";
  return (
    <div ref={root} data-intro={phase} className="contents">
      {children}
      {flying && (
        <div
          data-intro-overlay=""
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[950] overflow-hidden text-machine-ink"
        >
          <div ref={trail} />
          <div
            ref={flier}
            className="absolute top-0 left-0 opacity-0 will-change-transform"
          >
            <FlightBea />
          </div>
        </div>
      )}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function box(element: Element): Box {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

/** Runs the flight; returns what stops it (an unmount, or React's second effect run). */
function play(
  scope: HTMLElement,
  bea: HTMLElement,
  dots: HTMLElement,
  setPhase: (phase: Phase) => void,
  onPlayed: () => void,
): () => void {
  const headline = scope.querySelector<HTMLElement>("[data-intro-write]");
  const land = scope.querySelector<HTMLElement>("[data-intro-land]");
  const avatar = land?.querySelector<HTMLElement>(".bea-anim");
  if (!headline || !land || !avatar) {
    onPlayed();
    setPhase("done");
    return () => {};
  }

  const plan = planFlight(
    box(headline),
    parseFloat(getComputedStyle(headline).lineHeight) ||
      headline.getBoundingClientRect().height / 2,
    box(avatar),
    { width: window.innerWidth, height: window.innerHeight },
  );
  const originY = plan.size * BODY_CENTRE_Y;
  bea.style.width = `${plan.size}px`;
  bea.style.transformOrigin = `${plan.size / 2}px ${originY}px`;

  let frame = 0;
  let ended = false;
  let stage: "writing" | "flying" | "landed" = "writing";
  let angle = 0;
  let last = { x: plan.start.x, y: plan.start.y, t: 0 };
  let lastDot = Number.NEGATIVE_INFINITY;
  const timers: number[] = [];
  const started = performance.now();

  const stop = () => {
    ended = true;
    cancelAnimationFrame(frame);
    for (const timer of timers) window.clearTimeout(timer);
    for (const type of SKIP_EVENTS)
      window.removeEventListener(type, skip, true);
    window.removeEventListener("resize", skip);
    // All written: the mask may still apply for a frame until the phase re-renders.
    headline.style.setProperty("--intro-reveal", ALL_WRITTEN);
    for (const animation of land.getAnimations?.() ?? []) animation.cancel();
    land.style.removeProperty("clip-path");
  };
  const finish = () => {
    if (ended) return;
    stop();
    onPlayed();
    setPhase("done");
  };
  function skip() {
    finish();
  }

  const tick = (now: number) => {
    if (ended) return;
    const t = now - started;
    const pose = flightPose(plan, t);

    // She leans into where she's going, eased so turns read as banking, not snapping.
    const dt = Math.max(1, t - last.t);
    const vx = (pose.x - last.x) / dt;
    const vy = (pose.y - last.y) / dt;
    const lean =
      Math.max(-1, Math.min(1, vx / 1.2)) * 14 +
      Math.max(-1, Math.min(1, vy / 1.2)) * 8 * (vx < 0 ? -1 : 1);
    angle += (lean - angle) * 0.18;
    last = { x: pose.x, y: pose.y, t };

    bea.style.opacity = "1";
    bea.style.transform = `translate(${pose.x - plan.size / 2}px, ${pose.y - originY}px) rotate(${angle}deg) scale(${pose.scale})`;

    if (pose.stage === "writing") {
      headline.style.setProperty("--intro-reveal", `${pose.written}px`);
    } else if (stage === "writing") {
      headline.style.setProperty("--intro-reveal", ALL_WRITTEN);
      setPhase("flying");
    }
    stage = pose.stage;

    if (stage !== "landed" && t - lastDot >= DOT_EVERY_MS) {
      lastDot = t;
      // Pollen off her sting: a faint trail of where she's been.
      const reach = plan.size * 0.34 * pose.scale;
      const rad = (angle * Math.PI) / 180;
      dropDot(
        dots,
        pose.x - Math.sin(rad) * reach,
        pose.y + Math.cos(rad) * reach,
      );
    }

    if (stage === "landed") {
      landIn(land, avatar, bea, dots);
      setPhase("landing");
      timers.push(
        window.setTimeout(() => setPhase("hello"), LAND_MS),
        window.setTimeout(finish, LAND_MS + HELLO_MS),
      );
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  for (const type of SKIP_EVENTS)
    window.addEventListener(type, skip, { capture: true, passive: true });
  window.addEventListener("resize", skip);
  headline.style.setProperty("--intro-reveal", "0px");
  setPhase("writing");
  frame = requestAnimationFrame(tick);
  return stop;
}

const SKIP_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

function dropDot(layer: HTMLElement, x: number, y: number) {
  const dot = document.createElement("span");
  dot.className =
    "absolute top-0 left-0 size-[5px] rounded-full bg-current opacity-0";
  dot.style.transform = `translate(${x - 2.5}px, ${y - 2.5}px)`;
  layer.append(dot);
  const fade = dot.animate?.(
    [
      { opacity: 0.55, transform: `translate(${x - 2.5}px, ${y - 2.5}px)` },
      {
        opacity: 0,
        transform: `translate(${x - 2.5}px, ${y + 6}px) scale(0.4)`,
      },
    ],
    { duration: 700, easing: "ease-out" },
  );
  if (fade) fade.onfinish = () => dot.remove();
  else dot.remove();
}

/**
 * She settles where the button's avatar is: she fades into it as the button grows out of
 * her, from her circle to the whole pill, with one ring for the arrival.
 */
function landIn(
  land: HTMLElement,
  avatar: HTMLElement,
  bea: HTMLElement,
  layer: HTMLElement,
) {
  const spot = avatar.getBoundingClientRect();
  const button = land.getBoundingClientRect();
  const cx = spot.left + spot.width / 2 - button.left;
  const cy = spot.top + spot.height / 2 - button.top;
  const reach =
    Math.hypot(
      Math.max(cx, button.width - cx),
      Math.max(cy, button.height - cy),
    ) + 40;
  const from = `circle(${spot.width / 2}px at ${cx}px ${cy}px)`;
  land.style.clipPath = from;
  const grow = land.animate?.(
    [{ clipPath: from }, { clipPath: `circle(${reach}px at ${cx}px ${cy}px)` }],
    { duration: 520, easing: EASE_OUT, fill: "forwards" },
  );
  if (grow)
    grow.onfinish = () => {
      grow.cancel();
      land.style.removeProperty("clip-path");
    };
  else land.style.removeProperty("clip-path");

  bea.animate?.([{ opacity: 1 }, { opacity: 0 }], {
    duration: 220,
    easing: "ease-out",
    fill: "forwards",
  });

  const ring = document.createElement("span");
  ring.className =
    "absolute top-0 left-0 rounded-full border-2 border-current opacity-0";
  const size = spot.width;
  ring.style.width = ring.style.height = `${size}px`;
  ring.style.transform = `translate(${spot.left}px, ${spot.top}px)`;
  layer.append(ring);
  ring.animate?.(
    [
      { opacity: 0.6, transform: `translate(${spot.left}px, ${spot.top}px)` },
      {
        opacity: 0,
        transform: `translate(${spot.left}px, ${spot.top}px) scale(2.4)`,
      },
    ],
    { duration: 600, easing: EASE_OUT, fill: "forwards" },
  );
}

/**
 * Bea in flight: the character sheet's drawing, filled solid in ink, with her stripe and face
 * cut out of it and her wings a beating wash of ink. Still ink only (brand guidelines); once
 * she lands she's her usual outline again.
 */
function FlightBea() {
  const clip = `fb-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const line = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  const cut = { ...line, style: { stroke: "var(--bea-ground)" } };
  return (
    <svg
      viewBox="0 0 120 124"
      className="block h-auto w-full overflow-visible drop-shadow-[0_6px_10px_rgb(0_0_0/0.35)]"
    >
      <g className="fb-ant">
        <path d="M52 38 Q47 24 41 19M68 38 Q73 24 79 19" {...line} />
        <circle cx="41" cy="19" r="4.2" fill="currentColor" />
        <circle cx="79" cy="19" r="4.2" fill="currentColor" />
      </g>
      <g className="fb-wl">
        <ellipse
          cx="31"
          cy="40"
          rx="20"
          ry="12.5"
          transform="rotate(-32 31 40)"
          fill="currentColor"
          fillOpacity="0.35"
          stroke="currentColor"
          strokeWidth="5"
        />
      </g>
      <g className="fb-wr">
        <ellipse
          cx="89"
          cy="40"
          rx="20"
          ry="12.5"
          transform="rotate(32 89 40)"
          fill="currentColor"
          fillOpacity="0.35"
          stroke="currentColor"
          strokeWidth="5"
        />
      </g>
      <path d="M55 104 L60 111 L65 104" {...line} />
      <circle
        cx="60"
        cy="70"
        r="33"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="6"
      />
      <defs>
        <clipPath id={clip}>
          <circle cx="60" cy="70" r="30" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <path
          d="M34 100 L47 90 L60 100 L73 90 L86 100"
          {...cut}
          strokeWidth={5}
        />
      </g>
      <circle cx="48" cy="61" r="5" className="bea-ground" />
      <circle cx="72" cy="61" r="5" className="bea-ground" />
      <path d="M50 71 Q60 82 70 71" {...cut} />
    </svg>
  );
}
