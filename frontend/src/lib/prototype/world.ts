/**
 * The prototype's sandbox world: a pure state object plus pure actions. The React store
 * (`store.tsx`) persists it per browser. Nothing here talks to the backend; T32 hooks replace
 * these actions screen by screen.
 */
import {
  QUARTER_DATES,
  QUARTERS,
  SITE_META,
  siteDataFor,
  type Ecosystem,
  type LatLng,
  type ScenarioKey,
} from "./data";
import { compareGrades, GRADE_LABEL, price as fmtPrice } from "./format";
import { areaHa as polygonArea } from "./geo";
import { append, type LedgerEntry } from "./ledger";
import {
  ALPHA_RERATE,
  ALPHA_TICK,
  addDays,
  gauss,
  maxOrderUnits,
  priceAfterOrder,
  quote,
  reanchor,
  rng,
  round2,
  round4,
  seedHistory,
  type Side,
} from "./market";
import {
  buildReport,
  TOTAL_UNITS,
  type AuditorOverlay,
  type Report,
} from "./rating";
import { buildRun, type RatingRun } from "./trace";

export type PersonaKey = "steward" | "investor" | "admin";
export type TraderKey = "steward" | "investor";

export const PERSONAS: Record<
  PersonaKey,
  { name: string; role: string; app: string; home: string; initials: string }
> = {
  steward: {
    name: "Rosa",
    role: "Community steward",
    app: "Steward",
    home: "/steward",
    initials: "R",
  },
  investor: {
    name: "Arjun",
    role: "Impact investor",
    app: "Exchange",
    home: "/",
    initials: "A",
  },
  admin: {
    name: "Platform admin",
    role: "Control room",
    app: "Control room",
    home: "/admin",
    initials: "PA",
  },
};

export type EventKind =
  | "encroachment"
  | "restoration"
  | "protection"
  | "fire"
  | "drought"
  | "pollution";

export type NewsEvent = {
  id: string;
  siteId: string;
  kind: EventKind;
  direction: -1 | 0 | 1;
  severity: number;
  title: string;
  summary: string;
  date: string;
  source: "news" | "time_machine" | "evidence";
};

export type AlertItem = {
  id: string;
  siteId: string;
  persona: TraderKey;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  date: string;
  read: boolean;
};

export type Holding = { siteId: string; units: number; avgCost: number };

export type Order = {
  id: string;
  trader: TraderKey;
  siteId: string;
  side: Side;
  units: number;
  fill: number;
  total: number;
  primaryUnits: number;
  date: string;
};

export type PricePoint = {
  t: string;
  price: number;
  reason: "ipo" | "order" | "rerate" | "tick";
};

export type Verification = "verified" | "documents_submitted" | "unverified";

export type Site = {
  id: string;
  key: string;
  name: string;
  ecosystem: Ecosystem;
  place: string;
  region: string;
  community: string;
  description: string;
  stewardOwned: boolean;
  polygon: LatLng[];
  areaHa: number;
  status: "draft" | "listed" | "suspended";
  verification: Verification;
  verifiedAt: string | null;
  documents: string[];
  photos: number;
  totalUnits: number;
  retainedPct: number;
  primaryRemaining: number;
  /** Units sold back to the sandbox market maker; buys draw on these after the primary float. */
  marketMakerUnits: number;
  price: number;
  ipoPrice: number | null;
  listedAt: string | null;
  communityFund: number;
  scenario: ScenarioKey;
  reports: Report[];
  prices: PricePoint[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  siteId: string | null;
  citations: { label: string; href: string }[];
};

export type Draft = {
  step: number;
  name: string;
  description: string;
  polygon: LatLng[];
  documents: string[];
  photos: number;
  retainedPct: number;
};

export type TradeReceipt = {
  orderId: string;
  trader: TraderKey;
  siteId: string;
  side: Side;
  units: number;
  fill: number;
  total: number;
  primaryUnits: number;
  cashBefore: number;
  cashAfter: number;
  fundBefore: number;
  fundAfter: number;
};

export type World = {
  schema: 4;
  seq: number;
  quarter: number;
  today: string;
  persona: PersonaKey;
  community: { name: string; registered: boolean };
  cash: Record<TraderKey, number>;
  holdings: Record<TraderKey, Holding[]>;
  orders: Order[];
  sites: Site[];
  events: NewsEvent[];
  alerts: AlertItem[];
  ledger: Record<string, LedgerEntry[]>;
  runs: RatingRun[];
  copilot: ChatMessage[];
  draft: Draft;
  lastReceipt: TradeReceipt | null;
  tampered: Record<string, number>;
};

const START = QUARTER_DATES[0];
/** When the seeded sites were re-rated after their first news. */
const REVIEW_DATE = "2026-10-01";

/** Sample documents for the demo verification mode (ADR-0006 §6). */
export const SAMPLE_DOCUMENTS = [
  "Land title certificate (sample).pdf",
  "Assembly minutes, consent (sample).pdf",
  "Cooperative registration (sample).pdf",
];

export function hasConsentDocument(documents: string[]) {
  return documents.some((d) => /consent/i.test(d));
}

/** ADR-0006 deterministic checks, as far as the prototype can run them. */
export function documentChecks(documents: string[]) {
  const any = documents.length > 0;
  return {
    format: any ? "pass" : "not_run",
    not_reused: any ? "pass" : "not_run",
    boundary_free: "pass",
    consent_document: hasConsentDocument(documents)
      ? "pass"
      : any
        ? "fail"
        : "not_run",
  };
}

/** Events for a site in the year up to `date`: what a rating on that date could know. */
function eventsAt(world: World, siteId: string, date: string) {
  const from = addDays(date, -365);
  return world.events.filter(
    (e) => e.siteId === siteId && e.date <= date && e.date > from,
  );
}

/** Which account trades and receives alerts for the current persona. Admins never trade. */
export function actingTrader(persona: PersonaKey): TraderKey | null {
  return persona === "admin" ? null : persona;
}

function nextId(world: World, prefix: string): [World, string] {
  const seq = world.seq + 1;
  return [{ ...world, seq }, `${prefix}-${seq}`];
}

function auditorFor(
  scenario: ScenarioKey,
  photos: number,
  events: NewsEvent[],
): AuditorOverlay {
  const evidence = photos > 0;
  if (scenario === "encroachment") {
    const cited = events.filter((e) => e.direction < 0).slice(-1);
    return {
      agreement: 0.9,
      evidence,
      adjustment: -3,
      reason:
        "Satellite land-cover change and a recent news report agree on new built-up land at the edge. The latest months fall outside the land-cover window, so the score is lowered slightly beyond the formula.",
      citations: [
        "metric:landcover.built",
        "metric:water_change",
        ...cited.map((e) => `event:${e.id}`),
      ],
    };
  }
  if (scenario === "restoration") {
    return {
      agreement: 0.85,
      evidence,
      adjustment: 0,
      reason:
        "Greener vegetation and re-flooded water agree with the community's reported restoration work. No adjustment needed.",
      citations: ["metric:ndvi_trend", "metric:landcover.flooded_vegetation"],
    };
  }
  const cited = events.slice(-2);
  return {
    agreement: 0.8,
    evidence,
    adjustment: 0,
    reason:
      "Satellite metrics and local news are consistent; no event contradicts the measured trend. No adjustment needed.",
    citations: [
      "metric:ndvi_trend",
      "metric:natural_cover",
      ...cited.map((e) => `event:${e.id}`),
    ],
  };
}

const SAMPLE_NEWS: Record<string, Omit<NewsEvent, "id" | "siteId">[]> = {
  "celestun-mangrove": [
    {
      kind: "restoration",
      direction: 1,
      severity: 2,
      title: "Fishing cooperative reopens a silted tidal channel",
      summary:
        "Volunteers cleared about 400 m of channel, restoring tidal flow to a stressed mangrove patch.",
      date: "2026-09-02",
      source: "news",
    },
  ],
  "sumidero-forest": [
    {
      kind: "protection",
      direction: 1,
      severity: 2,
      title: "Ejido finishes fire breaks ahead of the dry season",
      summary:
        "Twelve kilometres of fire breaks were cut along the canyon rim.",
      date: "2026-09-21",
      source: "news",
    },
    {
      kind: "encroachment",
      direction: -1,
      severity: 2,
      title: "Small clearing reported near the canyon road",
      summary:
        "Residents reported about one hectare cleared for grazing outside the reserve fence.",
      date: "2026-08-30",
      source: "news",
    },
  ],
  "xochimilco-wetland": [
    {
      kind: "protection",
      direction: 1,
      severity: 2,
      title: "Borough approves a canal desilting programme",
      summary:
        "Funding covers desilting of six canals in the ecological park over two years.",
      date: "2026-09-18",
      source: "news",
    },
    {
      kind: "encroachment",
      direction: -1,
      severity: 2,
      title: "Industrial zone expansion proposed near the southern canals",
      summary:
        "A permit request for warehouse expansion bordering the wetland is under review.",
      date: "2026-10-03",
      source: "news",
    },
  ],
};

function seedSite(
  world: World,
  meta: (typeof SITE_META)[number],
  listedAt: string,
  seed: number,
) {
  const data = siteDataFor(meta.key);
  let w = world;
  let site: Site = {
    id: meta.id,
    key: meta.key,
    name: data.name,
    ecosystem: meta.ecosystem,
    place: meta.place,
    region: meta.region,
    community: meta.community,
    description: meta.description,
    stewardOwned: meta.stewardOwned,
    polygon: data.polygon,
    areaHa: data.areaHa,
    status: "draft",
    verification: "unverified",
    verifiedAt: null,
    documents: [],
    photos: 0,
    totalUnits: TOTAL_UNITS,
    retainedPct: 51,
    primaryRemaining: 0,
    marketMakerUnits: 0,
    price: 0,
    ipoPrice: null,
    listedAt: null,
    communityFund: 0,
    scenario: "baseline",
    reports: [],
    prices: [],
  };
  if (!meta.initiallyListed) return { world: w, site };

  // v1: the deterministic rating at listing, exactly as the backend seeds it (no news yet,
  // Auditor pending), so the opening price matches dev-spec §8 and the backend seed.
  const v1 = buildReport({
    siteKey: meta.key,
    siteName: data.name,
    scenario: "baseline",
    period: QUARTERS[0],
    version: 1,
    createdAt: listedAt,
    runId: `seed-${meta.id}`,
  });
  const ipo = v1.fairValuePerUnit;
  const before = seedHistory({
    seed,
    start: listedAt,
    until: REVIEW_DATE,
    ipo,
    fair: ipo,
  });

  for (const news of SAMPLE_NEWS[meta.id] ?? []) {
    const idNext = nextId(w, "ev");
    w = idNext[0];
    w = {
      ...w,
      events: [...w.events, { ...news, id: idNext[1], siteId: meta.id }],
    };
  }
  // v2: re-rated after the news, with the (scripted) Auditor review.
  const runIdNext = nextId(w, "run");
  w = runIdNext[0];
  const runId = runIdNext[1];
  const siteEvents = eventsAt(w, meta.id, REVIEW_DATE);
  const v2 = buildReport({
    siteKey: meta.key,
    siteName: data.name,
    scenario: "baseline",
    period: QUARTERS[0],
    version: 2,
    createdAt: REVIEW_DATE,
    runId,
    overlay: auditorFor("baseline", 0, siteEvents),
    events: siteEvents,
  });
  const run = buildRun({
    id: runId,
    siteId: meta.id,
    siteName: data.name,
    report: v2,
    trigger: "seed",
    startedAt: REVIEW_DATE,
    events: siteEvents,
    photos: 0,
    seed,
  });
  const rerated = reanchor(
    before[before.length - 1].price,
    v2.fairValuePerUnit,
    ALPHA_RERATE,
  );
  const after = seedHistory({
    seed: seed + 1,
    start: REVIEW_DATE,
    until: START,
    ipo: rerated,
    fair: v2.fairValuePerUnit,
  });
  const prices: PricePoint[] = [
    ...before.slice(0, -1),
    { t: REVIEW_DATE, price: rerated, reason: "rerate" },
    ...after.slice(1),
  ];
  const offered = Math.round(TOTAL_UNITS * 0.49);
  // Earlier supporters already bought some primary units.
  const sold = Math.round(offered * (0.03 + (seed % 7) / 1000));
  site = {
    ...site,
    status: "listed",
    verification: "verified",
    verifiedAt: addDays(listedAt, -4),
    documents: [...SAMPLE_DOCUMENTS],
    primaryRemaining: offered - sold,
    price: prices[prices.length - 1].price,
    ipoPrice: ipo,
    listedAt,
    communityFund: round2(sold * ipo),
    reports: [v1, v2],
    prices,
  };
  let chain: LedgerEntry[] = [];
  chain = append(chain, "listing", addDays(listedAt, -10), {
    site: site.name,
    community: site.community,
    area_ha: site.areaHa,
    polygon: site.polygon,
  });
  chain = append(chain, "verification", addDays(listedAt, -4), {
    level: "verified",
    evidence_kind: "sample",
    reviewer_role: "platform_admin",
    checks: documentChecks(site.documents),
  });
  chain = append(chain, "report", listedAt, reportPayload(v1));
  chain = append(chain, "price_anchor", listedAt, {
    reason: "ipo",
    price: ipo,
    units_offered: offered,
  });
  for (const e of [...siteEvents].sort((a, b) => (a.date < b.date ? -1 : 1)))
    chain = append(chain, "event", e.date, {
      title: e.title,
      direction: e.direction,
      severity: e.severity,
    });
  chain = append(chain, "report", REVIEW_DATE, reportPayload(v2));
  chain = append(chain, "price_anchor", REVIEW_DATE, {
    reason: "rerate",
    price: rerated,
  });
  w = {
    ...w,
    runs: [...w.runs, run],
    ledger: { ...w.ledger, [meta.id]: chain },
  };
  return { world: w, site };
}

function reportPayload(r: Report) {
  return {
    version: r.version,
    period: r.period,
    health: r.health,
    grade: r.grade,
    confidence: r.confidence,
    value_mid: r.valueMid,
    fair_value_per_unit: r.fairValuePerUnit,
  };
}

export function createInitialWorld(persona: PersonaKey = "investor"): World {
  let world: World = {
    schema: 4,
    seq: 0,
    quarter: 0,
    today: START,
    persona,
    community: { name: SITE_META[0].community, registered: false },
    cash: { steward: 10_000, investor: 10_000 },
    holdings: { steward: [], investor: [] },
    orders: [],
    sites: [],
    events: [],
    alerts: [],
    ledger: {},
    runs: [],
    copilot: [],
    draft: {
      step: 0,
      name: SITE_META[0].community.replace(" Cooperative", ""),
      description: SITE_META[0].description,
      polygon: [],
      documents: [],
      photos: 0,
      retainedPct: 51,
    },
    lastReceipt: null,
    tampered: {},
  };
  const listed: Record<string, [string, number]> = {
    "celestun-mangrove": ["2026-08-03", 11],
    "sumidero-forest": ["2026-08-17", 23],
  };
  const sites: Site[] = [];
  for (const meta of SITE_META) {
    const [listedAt, seed] = listed[meta.id] ?? [START, 5];
    const out = seedSite(world, meta, listedAt, seed);
    world = out.world;
    sites.push(out.site);
  }
  world = { ...world, sites };
  // Arjun already backs the forest site.
  const forest = sites.find((s) => s.id === "sumidero-forest");
  if (forest) {
    const units = 120;
    const avg = round4(forest.prices[20]?.price ?? forest.price);
    world = {
      ...world,
      cash: { ...world.cash, investor: round2(10_000 - units * avg) },
      holdings: {
        ...world.holdings,
        investor: [{ siteId: forest.id, units, avgCost: avg }],
      },
    };
  }
  return world;
}

export function siteById(world: World, id: string) {
  return world.sites.find((s) => s.id === id);
}

/** Percent change of the stake price since the site opened. */
export function changeSinceOpen(site: Site) {
  const first = site.prices[0]?.price;
  return first ? ((site.price - first) / first) * 100 : 0;
}

export function latestReport(site: Site): Report | undefined {
  return site.reports[site.reports.length - 1];
}

export function previousReport(site: Site): Report | undefined {
  return site.reports[site.reports.length - 2];
}

function updateSite(world: World, id: string, patch: (s: Site) => Site): World {
  return {
    ...world,
    sites: world.sites.map((s) => (s.id === id ? patch(s) : s)),
  };
}

function addAlert(world: World, alert: Omit<AlertItem, "id" | "read">): World {
  const [w, id] = nextId(world, "al");
  return { ...w, alerts: [{ ...alert, id, read: false }, ...w.alerts] };
}

function addLedger(
  world: World,
  siteId: string,
  kind: Parameters<typeof append>[1],
  payload: Record<string, unknown>,
) {
  return {
    ...world,
    ledger: {
      ...world.ledger,
      [siteId]: append(world.ledger[siteId] ?? [], kind, world.today, payload),
    },
  };
}

// ---------- Steward ----------

export function registerCommunity(world: World, name: string): World {
  return {
    ...world,
    community: { name: name.trim() || world.community.name, registered: true },
  };
}

export function updateDraft(world: World, patch: Partial<Draft>): World {
  return { ...world, draft: { ...world.draft, ...patch } };
}

export const HERO_ID = "xochimilco-wetland";

/** Fixed seed so the listing preview and the stored run show the same steps and timings. */
const LISTING_RUN_SEED = 17;

function samePolygon(a: LatLng[], b: LatLng[]) {
  return (
    a.length === b.length &&
    a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1])
  );
}

/**
 * Runs the (recorded) rating pipeline on the steward's draft and stores the report. Pure, so
 * the listing screen can preview the exact run before it's stored.
 */
export function rateDraft(world: World): World {
  const site = siteById(world, HERO_ID);
  if (!site) return world;
  const data = siteDataFor(site.key);
  let w = world;
  if (!w.events.some((e) => e.siteId === HERO_ID)) {
    for (const news of SAMPLE_NEWS[HERO_ID]) {
      const idNext = nextId(w, "ev");
      w = idNext[0];
      w = {
        ...w,
        events: [...w.events, { ...news, id: idNext[1], siteId: HERO_ID }],
      };
    }
  }
  const runIdNext = nextId(w, "run");
  w = runIdNext[0];
  const runId = runIdNext[1];
  const saved = data.polygon.slice(0, -1);
  const drawn = w.draft.polygon.length >= 3 ? w.draft.polygon : saved;
  const custom = !samePolygon(drawn, saved);
  const area = custom ? Math.round(polygonArea(drawn) * 10) / 10 : data.areaHa;
  const events = eventsAt(w, HERO_ID, w.today);
  const report = buildReport({
    siteKey: site.key,
    siteName: site.name,
    scenario: "baseline",
    period: QUARTERS[w.quarter],
    version: site.reports.length + 1,
    createdAt: w.today,
    runId,
    overlay: auditorFor("baseline", w.draft.photos, events),
    events,
    areaHa: area,
  });
  const run = buildRun({
    id: runId,
    siteId: HERO_ID,
    siteName: site.name,
    report,
    trigger: "listing",
    startedAt: w.today,
    events,
    photos: w.draft.photos,
    seed: LISTING_RUN_SEED,
  });
  w = updateSite(w, HERO_ID, (s) => ({
    ...s,
    description: w.draft.description,
    polygon: custom ? drawn : data.polygon,
    areaHa: area,
    documents: w.draft.documents,
    photos: w.draft.photos,
    verification: w.draft.documents.length
      ? "documents_submitted"
      : "unverified",
    reports: [...s.reports, report],
  }));
  if (!w.ledger[HERO_ID]?.length) {
    w = addLedger(w, HERO_ID, "listing", {
      site: site.name,
      community: w.community.name,
      area_ha: area,
      polygon: custom ? drawn : data.polygon,
    });
  }
  w = addLedger(w, HERO_ID, "report", reportPayload(report));
  return {
    ...w,
    runs: [...w.runs, run],
    draft: { ...w.draft, step: Math.max(w.draft.step, 4) },
  };
}

export function launchOffer(world: World, retainedPct: number): World {
  const site = siteById(world, HERO_ID);
  const report = site && latestReport(site);
  if (!site || !report || site.status === "listed") return world;
  const offered = Math.round((TOTAL_UNITS * (100 - retainedPct)) / 100);
  const ipo = report.fairValuePerUnit;
  let w = updateSite(world, HERO_ID, (s) => ({
    ...s,
    status: "listed",
    retainedPct,
    primaryRemaining: offered,
    price: ipo,
    ipoPrice: ipo,
    listedAt: world.today,
    prices: [{ t: world.today, price: ipo, reason: "ipo" }],
  }));
  w = addLedger(w, HERO_ID, "price_anchor", {
    reason: "ipo",
    price: ipo,
    units_offered: offered,
  });
  return { ...w, draft: { ...w.draft, step: 5 } };
}

/** Steward adds geotagged photos after listing: re-rate with field evidence. */
export function addEvidence(
  world: World,
  siteId: string,
  photos: number,
): World {
  const site = siteById(world, siteId);
  if (!site || !latestReport(site)) return world;
  const w = updateSite(world, siteId, (s) => ({
    ...s,
    photos: s.photos + photos,
  }));
  return rerate(w, siteId, site.scenario, "event");
}

// ---------- Market ----------

export type OrderResult =
  | { ok: true; world: World; receipt: TradeReceipt }
  | { ok: false; message: string };

export function placeOrder(
  world: World,
  trader: TraderKey,
  siteId: string,
  side: Side,
  units: number,
): OrderResult {
  const site = siteById(world, siteId);
  if (site?.status === "suspended")
    return {
      ok: false,
      message: "Trading is paused on this site while the platform reviews it.",
    };
  if (!site || site.status !== "listed")
    return { ok: false, message: "This site isn't open for stakes yet." };
  if (trader === "steward" && site.stewardOwned)
    return {
      ok: false,
      message:
        "Members of a community can't trade their own site's stakes. The retained stake earns the community's share instead.",
    };
  if (!Number.isInteger(units) || units <= 0)
    return { ok: false, message: "Enter a whole number of units." };
  const max = maxOrderUnits(site.totalUnits);
  if (units > max)
    return {
      ok: false,
      message: `One order can be at most ${max.toLocaleString("en-US")} units.`,
    };
  const available = site.primaryRemaining + site.marketMakerUnits;
  if (side === "buy" && units > available)
    return {
      ok: false,
      message: `Only ${available.toLocaleString("en-US")} units are available right now.`,
    };
  const fill = quote(site.price, side, units, site.totalUnits);
  const total = round2(fill * units);
  const holdings = world.holdings[trader];
  const holding = holdings.find((h) => h.siteId === siteId);
  const cash = world.cash[trader];
  if (side === "buy" && total > cash)
    return {
      ok: false,
      message: `You have ${fmtPrice(cash)} of play money. This needs ${fmtPrice(total)}.`,
    };
  if (side === "sell" && (!holding || holding.units < units))
    return {
      ok: false,
      message: `You hold ${holding?.units ?? 0} units of this site.`,
    };
  const primaryUnits =
    side === "buy" ? Math.min(units, site.primaryRemaining) : 0;
  const fundGain = round2(primaryUnits * fill);
  const newPrice = priceAfterOrder(site.price, side, units, site.totalUnits);
  const marketMakerDelta = side === "buy" ? -(units - primaryUnits) : units;
  let w: World;
  const orderIdNext = nextId(world, "ord");
  w = orderIdNext[0];
  const orderId = orderIdNext[1];
  const nextHoldings =
    side === "buy"
      ? holding
        ? holdings.map((h) =>
            h.siteId === siteId
              ? {
                  ...h,
                  units: h.units + units,
                  avgCost: round4(
                    (h.avgCost * h.units + total) / (h.units + units),
                  ),
                }
              : h,
          )
        : [...holdings, { siteId, units, avgCost: fill }]
      : holdings
          .map((h) =>
            h.siteId === siteId ? { ...h, units: h.units - units } : h,
          )
          .filter((h) => h.units > 0);
  const cashAfter = round2(side === "buy" ? cash - total : cash + total);
  w = {
    ...w,
    cash: { ...w.cash, [trader]: cashAfter },
    holdings: { ...w.holdings, [trader]: nextHoldings },
    orders: [
      {
        id: orderId,
        trader,
        siteId,
        side,
        units,
        fill,
        total,
        primaryUnits,
        date: w.today,
      },
      ...w.orders,
    ],
  };
  w = updateSite(w, siteId, (s) => ({
    ...s,
    price: newPrice,
    primaryRemaining: s.primaryRemaining - primaryUnits,
    marketMakerUnits: s.marketMakerUnits + marketMakerDelta,
    communityFund: round2(s.communityFund + fundGain),
    prices: [...s.prices, { t: w.today, price: newPrice, reason: "order" }],
  }));
  const receipt: TradeReceipt = {
    orderId,
    trader,
    siteId,
    side,
    units,
    fill,
    total,
    primaryUnits,
    cashBefore: cash,
    cashAfter,
    fundBefore: site.communityFund,
    fundAfter: round2(site.communityFund + fundGain),
  };
  return { ok: true, world: { ...w, lastReceipt: receipt }, receipt };
}

/** Background drift toward the latest fair price; replaces today's tick to keep daily points. */
export function tick(world: World, nonce: number): World {
  const random = rng(nonce);
  return {
    ...world,
    sites: world.sites.map((s) => {
      const report = latestReport(s);
      if (s.status !== "listed" || !report) return s;
      const next = reanchor(
        s.price,
        report.fairValuePerUnit,
        ALPHA_TICK,
        gauss(random, 0.0025),
      );
      const last = s.prices[s.prices.length - 1];
      const point: PricePoint = { t: world.today, price: next, reason: "tick" };
      const prices =
        last && last.t === world.today && last.reason === "tick"
          ? [...s.prices.slice(0, -1), point]
          : [...s.prices, point];
      return { ...s, price: next, prices };
    }),
  };
}

// ---------- Re-rating, Time Machine, events ----------

function rerate(
  world: World,
  siteId: string,
  scenario: ScenarioKey,
  trigger: RatingRun["trigger"],
): World {
  const site = siteById(world, siteId);
  const prev = site && latestReport(site);
  if (!site || !prev) return world;
  let w = world;
  const runIdNext = nextId(w, "run");
  w = runIdNext[0];
  const runId = runIdNext[1];
  const events = eventsAt(w, siteId, w.today);
  const report = buildReport({
    siteKey: site.key,
    siteName: site.name,
    scenario,
    period: QUARTERS[w.quarter],
    version: site.reports.length + 1,
    createdAt: w.today,
    runId,
    overlay: auditorFor(scenario, site.photos, events),
    events,
    areaHa: site.areaHa,
  });
  const run = buildRun({
    id: runId,
    siteId,
    siteName: site.name,
    report,
    trigger,
    startedAt: w.today,
    events,
    photos: site.photos,
    seed: w.seq,
  });
  const listed = site.status === "listed";
  const newPrice = listed
    ? reanchor(site.price, report.fairValuePerUnit, ALPHA_RERATE)
    : site.price;
  w = updateSite(w, siteId, (s) => ({
    ...s,
    scenario,
    reports: [...s.reports, report],
    price: newPrice,
    prices: listed
      ? [...s.prices, { t: w.today, price: newPrice, reason: "rerate" }]
      : s.prices,
  }));
  w = { ...w, runs: [...w.runs, run] };
  w = addLedger(w, siteId, "report", reportPayload(report));
  if (listed)
    w = addLedger(w, siteId, "price_anchor", {
      reason: "rerate",
      price: newPrice,
    });

  const change = compareGrades(report.grade, prev.grade);
  if (change !== 0) {
    const verb = change > 0 ? "Upgraded" : "Downgraded";
    const cause =
      scenario === "encroachment"
        ? "encroachment reported at the edge of the site"
        : scenario === "restoration"
          ? "restoration detected in the latest satellite data"
          : "new satellite data";
    const pctMove = listed ? ((newPrice - site.price) / site.price) * 100 : 0;
    for (const trader of ["investor", "steward"] as TraderKey[]) {
      const holds = w.holdings[trader].some((h) => h.siteId === siteId);
      const owns = trader === "steward" && site.stewardOwned;
      if (!holds && !owns) continue;
      w = addAlert(w, {
        siteId,
        persona: trader,
        severity: change < 0 ? "critical" : "info",
        title: `${verb} ${prev.grade} → ${report.grade}: ${site.name}`,
        message: owns
          ? `${verb} after ${cause}. ${change < 0 ? "See the stewardship actions on your listing." : "Your community's work shows in the data."}`
          : `${verb} after ${cause}. Stake price ${pctMove >= 0 ? "up" : "down"} ${Math.abs(pctMove).toFixed(1)}% (play money).`,
        date: w.today,
      });
    }
  }
  return w;
}

export function nextQuarter(world: World): World {
  if (world.quarter >= QUARTERS.length - 1) return world;
  const quarter = world.quarter + 1;
  const today = QUARTER_DATES[quarter];
  let w: World = { ...world, quarter, today };
  // Fill daily ticks across the skipped quarter so charts stay continuous.
  w = {
    ...w,
    sites: w.sites.map((s, i) => {
      const report = latestReport(s);
      if (s.status !== "listed" || !report) return s;
      const filled = seedHistory({
        seed: quarter * 97 + i,
        start: world.today,
        until: addDays(today, -1),
        ipo: s.price,
        fair: report.fairValuePerUnit,
      }).slice(1);
      const last = filled[filled.length - 1];
      return {
        ...s,
        prices: [...s.prices, ...filled],
        price: last?.price ?? s.price,
      };
    }),
  };
  for (const site of w.sites) {
    if (!latestReport(site)) continue;
    // Scripted timeline (T13): restoration shows up the next quarter unless something worse happened.
    const scenario: ScenarioKey =
      quarter === 1 && site.scenario === "baseline"
        ? "restoration"
        : site.scenario;
    w = rerate(w, site.id, scenario, "time_machine");
  }
  return w;
}

export function injectEvent(
  world: World,
  siteId: string,
  kind: "encroachment" | "restoration",
): World {
  const site = siteById(world, siteId);
  if (!site || !latestReport(site)) return world;
  const presets: Record<
    string,
    Record<typeof kind, Omit<NewsEvent, "id" | "siteId" | "date">>
  > = {
    "xochimilco-wetland": {
      encroachment: {
        kind: "encroachment",
        direction: -1,
        severity: 4,
        title: "Industrial park fill reported on the wetland's northern edge",
        summary:
          "Residents report trucks filling marsh and canal margins for a warehouse park; surface water has dropped.",
        source: "time_machine",
      },
      restoration: {
        kind: "restoration",
        direction: 1,
        severity: 3,
        title: "Cooperative re-floods chinampa canals and replants willows",
        summary:
          "Abandoned plots were re-flooded and native ahuejote willows planted along the banks.",
        source: "time_machine",
      },
    },
    "celestun-mangrove": {
      encroachment: {
        kind: "encroachment",
        direction: -1,
        severity: 4,
        title: "Shrimp pond construction clears mangrove near the lagoon",
        summary: "A new aquaculture pond was cut into the mangrove fringe.",
        source: "time_machine",
      },
      restoration: {
        kind: "restoration",
        direction: 1,
        severity: 3,
        title: "Tidal channels reopened and mangrove replanted",
        summary: "Hydrological restoration reopened blocked channels.",
        source: "time_machine",
      },
    },
    "sumidero-forest": {
      encroachment: {
        kind: "encroachment",
        direction: -1,
        severity: 4,
        title: "Illegal clearing for pasture on the canyon slopes",
        summary: "A cleared strip was burned for pasture inside the site.",
        source: "time_machine",
      },
      restoration: {
        kind: "restoration",
        direction: 1,
        severity: 3,
        title: "Nursery seedlings planted across cleared slopes",
        summary: "The ejido planted native seedlings on degraded slopes.",
        source: "time_machine",
      },
    },
  };
  let w = world;
  const idNext = nextId(w, "ev");
  w = idNext[0];
  const id = idNext[1];
  const event: NewsEvent = {
    ...presets[siteId][kind],
    id,
    siteId,
    date: w.today,
  };
  w = { ...w, events: [...w.events, event] };
  w = addLedger(w, siteId, "event", {
    title: event.title,
    direction: event.direction,
    severity: event.severity,
  });
  return rerate(w, siteId, kind, "event");
}

export function setVerification(
  world: World,
  siteId: string,
  level: Verification,
): World {
  const w = updateSite(world, siteId, (s) => ({
    ...s,
    verification: level,
    verifiedAt: level === "verified" ? world.today : s.verifiedAt,
  }));
  const site = siteById(w, siteId);
  return addLedger(w, siteId, "verification", {
    level,
    evidence_kind: "sample",
    reviewer_role: "platform_admin",
    checks: documentChecks(site?.documents ?? []),
  });
}

export function setSuspended(
  world: World,
  siteId: string,
  suspended: boolean,
): World {
  return updateSite(world, siteId, (s) =>
    s.status === "draft"
      ? s
      : { ...s, status: suspended ? "suspended" : "listed" },
  );
}

/** Ledger tamper demo: edit a recorded report's health without re-hashing. */
export function tamperLedger(world: World, siteId: string): World {
  const chain = world.ledger[siteId];
  if (!chain) return world;
  const idx = chain.findIndex((e) => e.kind === "report");
  if (idx < 0) return world;
  const entry = chain[idx];
  const health = Number(entry.payload.health ?? 0);
  const forged = {
    ...entry,
    payload: {
      ...entry.payload,
      health: Math.round((health + 12) * 10) / 10,
      grade: "AAA",
    },
  };
  return {
    ...world,
    ledger: {
      ...world.ledger,
      [siteId]: chain.map((e, i) => (i === idx ? forged : e)),
    },
    tampered: { ...world.tampered, [siteId]: idx },
  };
}

export function markAlertsRead(world: World, persona: TraderKey): World {
  return {
    ...world,
    alerts: world.alerts.map((a) =>
      a.persona === persona ? { ...a, read: true } : a,
    ),
  };
}

export function gradeLine(report: Report) {
  return `${report.grade} · ${report.health.toFixed(1)} · ${GRADE_LABEL[report.grade]}`;
}

/** True until the visitor changes anything (price ticks don't count). */
export function isFreshWorld(world: World) {
  const initial = createInitialWorld(world.persona);
  return (
    world.quarter === 0 &&
    world.orders.length === 0 &&
    world.events.length === initial.events.length &&
    world.runs.length === initial.runs.length &&
    world.copilot.length === 0 &&
    !world.community.registered &&
    world.draft.step === 0 &&
    world.draft.polygon.length === 0 &&
    world.draft.documents.length === 0 &&
    world.draft.photos === 0 &&
    Object.keys(world.tampered).length === 0 &&
    world.sites.every(
      (s, i) =>
        s.status === initial.sites[i]?.status &&
        s.verification === initial.sites[i]?.verification,
    )
  );
}
