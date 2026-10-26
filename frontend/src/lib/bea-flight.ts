/**
 * Bea's flight on the welcome (components/welcome/bea-intro.tsx), as pure geometry: where she
 * is at time `t`, and how much of the headline she has written. Positions are viewport pixels
 * of her body's centre; `scale` shrinks her from her flying size to the Ask Bea avatar's.
 */

export type Point = { x: number; y: number };
export type Box = { left: number; top: number; width: number; height: number };

export type FlightPlan = {
  /** Her width in flight, before she shrinks to land. */
  size: number;
  start: Point;
  /** Where the writing ends and the flight to the button begins. */
  turn: Point;
  /** How far she bobs up and down while writing. */
  bob: number;
  controls: readonly [Point, Point];
  land: Point;
  landScale: number;
  writeMs: number;
  flyMs: number;
  /** The headline's left edge: the written part is measured from here. */
  writeFrom: number;
};

export type FlightPose = Point & {
  stage: "writing" | "flying" | "landed";
  scale: number;
  /** Pixels of the headline written so far, from its left edge. */
  written: number;
};

/** Her drawing is 120 wide; her body's centre sits 70 down it (the character sheet). */
export const BODY_CENTRE_Y = 70 / 120;
/** In the avatar medallion she's drawn at 75%, her body's centre 64.5 / 120 down. */
const AVATAR_SCALE = 0.75;
const AVATAR_BODY_Y = 64.5 / 120;

const WRITE_SPEED = 0.62; // px per ms
const FLY_SPEED = 0.9;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * From the headline she writes, its line height, the Ask Bea avatar she lands in and the
 * viewport: she enters from off the left edge, sweeps across the headline, then arcs up and
 * over to the button, arriving from above.
 */
export function planFlight(
  headline: Box,
  lineHeight: number,
  avatar: Box,
  viewport: { width: number; height: number },
): FlightPlan {
  const size = clamp(lineHeight * 1.15, 56, 104);
  const start = { x: -size, y: headline.top + headline.height * 0.3 };
  const turn = {
    x: Math.min(
      headline.left + headline.width + size * 0.55,
      viewport.width - size * 0.6,
    ),
    y: headline.top + headline.height * 0.62,
  };
  const land = {
    x: avatar.left + avatar.width / 2,
    y: avatar.top + avatar.height * AVATAR_BODY_Y,
  };
  const controls = [
    {
      x: turn.x + 0.55 * (land.x - turn.x),
      y: turn.y - 0.12 * viewport.height,
    },
    { x: land.x - 0.1 * viewport.width, y: land.y - 0.24 * viewport.height },
  ] as const;
  return {
    size,
    start,
    turn,
    bob: Math.min(headline.height * 0.12, 18),
    controls,
    land,
    landScale: (avatar.width * AVATAR_SCALE) / size,
    writeMs: clamp((turn.x - start.x) / WRITE_SPEED, 900, 1500),
    flyMs: clamp(
      Math.hypot(land.x - turn.x, land.y - turn.y) / FLY_SPEED,
      800,
      1200,
    ),
    writeFrom: headline.left,
  };
}

/** Where she is `t` ms into the flight. */
export function flightPose(plan: FlightPlan, t: number): FlightPose {
  if (t < plan.writeMs) {
    // Fast as she enters, slowing as she finishes the line: a pen's stroke.
    const e = Math.sin((clamp(t / plan.writeMs, 0, 1) * Math.PI) / 2);
    const x = lerp(plan.start.x, plan.turn.x, e);
    const y =
      lerp(plan.start.y, plan.turn.y, e) + plan.bob * Math.sin(e * 3 * Math.PI);
    return {
      x,
      y,
      stage: "writing",
      scale: 1,
      written: Math.max(0, x - plan.writeFrom - plan.size * 0.1),
    };
  }
  const v = clamp((t - plan.writeMs) / plan.flyMs, 0, 1);
  const point = bezier(
    plan.turn,
    plan.controls[0],
    plan.controls[1],
    plan.land,
    easeInOutSine(v),
  );
  return {
    ...point,
    stage: v >= 1 ? "landed" : "flying",
    scale: lerp(1, plan.landScale, easeInOutSine(v) ** 1.3),
    written: Number.POSITIVE_INFINITY,
  };
}
