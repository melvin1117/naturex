/**
 * Sandbox market, mirroring `backend/app/market/engine.py` (dev-spec §8): instant fills with
 * slippage, primary units first (proceeds go to the community fund), re-anchoring to the fair
 * price on re-rate. Play money only.
 */
export const K_SLIPPAGE = 0.5;
export const LIQUIDITY_SHARE = 0.05;
export const BETA = 0.5;
export const ALPHA_RERATE = 0.35;
export const ALPHA_TICK = 0.05;
export const MAX_SLIPPAGE = 0.1;

export type Side = "buy" | "sell";

export function liquidity(totalUnits: number) {
  return totalUnits * LIQUIDITY_SHARE;
}

export function maxOrderUnits(totalUnits: number) {
  return Math.floor((MAX_SLIPPAGE * liquidity(totalUnits)) / K_SLIPPAGE);
}

export function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}

export function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** Fill price: price × (1 ± k × qty / liquidity). */
export function quote(
  price: number,
  side: Side,
  units: number,
  totalUnits: number,
) {
  const slippage = (K_SLIPPAGE * units) / liquidity(totalUnits);
  return round4(price * (1 + (side === "buy" ? 1 : -1) * slippage));
}

export const MIN_PRICE = 0.0001;

/**
 * Price after an order, as in `engine.execute`: price + β × price × signed_qty / liquidity.
 * With β = k this equals the fill price, so the next order starts where this one filled.
 */
export function priceAfterOrder(
  price: number,
  side: Side,
  units: number,
  totalUnits: number,
) {
  const signed = side === "buy" ? units : -units;
  return Math.max(
    MIN_PRICE,
    round4(price + (BETA * price * signed) / liquidity(totalUnits)),
  );
}

/** Largest whole number of units whose total (with slippage) fits the cash and supply. */
export function maxAffordableUnits(
  price: number,
  cash: number,
  totalUnits: number,
  available: number,
) {
  let units = Math.min(
    Math.floor(cash / price),
    maxOrderUnits(totalUnits),
    available,
  );
  while (
    units > 0 &&
    round2(quote(price, "buy", units, totalUnits) * units) > cash
  )
    units -= 1;
  return Math.max(0, units);
}

export function reanchor(
  price: number,
  fair: number,
  alpha: number,
  noise = 0,
) {
  const anchored = price + alpha * (fair - price);
  return Math.max(MIN_PRICE, round4(anchored * (1 + noise)));
}

/** Deterministic PRNG (mulberry32), so the seeded world renders the same on server and client. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(random: () => number, sigma: number) {
  const u = Math.max(random(), 1e-9);
  const v = random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-3, Math.min(3, z)) * sigma;
}

export function addDays(iso: string, days: number) {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Daily history from the opening offer to `until`: ticks toward fair value plus order flow. */
export function seedHistory(args: {
  seed: number;
  start: string;
  until: string;
  ipo: number;
  fair: number;
}) {
  const random = rng(args.seed);
  const points: {
    t: string;
    price: number;
    reason: "ipo" | "tick" | "order";
  }[] = [{ t: args.start, price: args.ipo, reason: "ipo" }];
  let price = args.ipo;
  let day = args.start;
  // A gentle demand drift so a listed site does not sit flat at its opening price.
  const drift = args.fair * (1 + 0.04 * (random() - 0.3));
  while (day < args.until) {
    day = addDays(day, 1);
    const flow = random() < 0.25 ? (random() - 0.4) * 0.012 : 0;
    price = reanchor(price, drift, ALPHA_TICK, gauss(random, 0.004) + flow);
    points.push({ t: day, price, reason: flow ? "order" : "tick" });
  }
  return points;
}
