import type {
  AssetCard,
  SentAlert,
  SimulateEvent,
  SimulateQuarter,
  TimeMachine,
  WorldOut,
} from "@/lib/api/types";

import { WORLD } from "../lib/helpers";

export const HERO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FOREST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const DRAFT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A demo session as the sandbox's admin persona. */
export const DEMO_ADMIN_WORLD: WorldOut = {
  ...WORLD,
  me: {
    id: "77777777-7777-4777-8777-777777777777",
    name: "Demo admin",
    email: null,
    kind: "persona",
    is_admin: true,
    world_id: WORLD.id,
  },
};

/** A live-world admin (a password account). */
export const LIVE_ADMIN_WORLD: WorldOut = {
  ...WORLD,
  me: { ...DEMO_ADMIN_WORLD.me!, kind: "person", email: "ops@example.org" },
};

export const STATE: TimeMachine = {
  step: 0,
  current: {
    step: 0,
    period: "2026Q3",
    scenario: "baseline",
    data_version: null,
  },
  next: {
    step: 1,
    period: "2026Q4",
    scenario: "restoration",
    data_version: "sim-1",
  },
  timeline: [
    { step: 0, period: "2026Q3", scenario: "baseline", data_version: null },
    {
      step: 1,
      period: "2026Q4",
      scenario: "restoration",
      data_version: "sim-1",
    },
    {
      step: 2,
      period: "2027Q1",
      scenario: "encroachment",
      data_version: "sim-2",
    },
  ],
  presets: [
    {
      preset: "fire",
      label: "Fire",
      impact_type: "fire",
      direction: -1,
      severity: 5,
      alerts: true,
      description: "A wildfire burns part of the tree cover.",
    },
    {
      preset: "encroachment",
      label: "Encroachment",
      impact_type: "encroachment",
      direction: -1,
      severity: 4,
      alerts: true,
      description: "Industrial fill turns wetland edge into built-up land.",
    },
    {
      preset: "restoration",
      label: "Restoration",
      impact_type: "restoration",
      direction: 1,
      severity: 2,
      alerts: false,
      description: "Canals re-flooded and native trees replanted.",
    },
  ],
  local_jobs: true,
};

function card(id: string, name: string, overrides: Partial<AssetCard> = {}) {
  return {
    id,
    name,
    site_key: null,
    status: "listed",
    country: "MX",
    area_ha: "100",
    grade: "A",
    health_score: "76.2",
    confidence: "80",
    price: "21.00",
    price_change_pct: 0,
    trading: true,
    ...overrides,
  } as AssetCard;
}

export const ASSETS: AssetCard[] = [
  card(FOREST, "Sumidero Forest"),
  card(HERO, "Xochimilco Wetland", { site_key: "wetland_mx" }),
  card(DRAFT, "Draft Meadow", { status: "draft" }),
];

const rating = (health: string, grade: string, price: string, v: number) => ({
  report_id: `r${v}`,
  version: v,
  health_score: health,
  grade,
  data_version: v === 1 ? "2026Q3" : "sim-1",
  simulated: v > 1,
  fair_value_per_share: price,
  price,
});

export const QUARTER: SimulateQuarter = {
  step: 1,
  period: "2026Q4",
  scenario: "restoration",
  data_version: "sim-1",
  payout_label: "2026Q4-sim-1",
  replayed: false,
  assets_rerated: 1,
  assets_failed: 0,
  assets_skipped: 1,
  payouts: 2,
  alerts: 1,
  stopped: null,
  assets: [
    {
      asset_id: HERO,
      name: "Xochimilco Wetland",
      status: "rerated",
      run_id: "11111111-0000-4000-8000-000000000001",
      before: rating("76.2", "A", "21.4700", 1),
      after: rating("81.3", "AA", "23.1000", 2),
      alert_ids: ["alert-1"],
      payout: "paid",
    },
    {
      asset_id: FOREST,
      name: "Sumidero Forest",
      status: "skipped",
      detail: "no_time_machine_version",
      before: rating("60.0", "BBB", "15.0000", 1),
      after: null,
      alert_ids: [],
      payout: "paid",
    },
  ],
};

export const EVENT: SimulateEvent = {
  event: {
    id: "e-1",
    asset_id: HERO,
    source: "admin",
    title: "Encroachment at Xochimilco Wetland (simulated)",
    impact_type: "encroachment",
    direction: -1,
    severity: 4,
    created_at: "2026-10-20T10:00:00Z",
  },
  preset: "encroachment",
  period: "2026Q3",
  data_version: "sim-0-encroachment",
  description: "Industrial fill turns wetland edge into built-up land.",
  run_id: "11111111-0000-4000-8000-000000000002",
  before: rating("76.2", "A", "21.4700", 1),
  after: rating("65.4", "BBB", "18.2000", 2),
  alert_ids: ["alert-2", "alert-3"],
  alert_created: true,
};

export function sentAlert(id: string, overrides: Partial<SentAlert> = {}) {
  return {
    id,
    asset_id: HERO,
    asset_name: "Xochimilco Wetland",
    kind: "grade_change",
    title: `Xochimilco Wetland: alert ${id}`,
    message: "The grade moved after a new rating.",
    severity: 4,
    created_at: "2026-10-20T10:00:00Z",
    recipients: 3,
    ...overrides,
  } satisfies SentAlert;
}
