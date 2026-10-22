/**
 * Static data for the clickable prototype. Numbers come from `sites.json`, produced by running
 * the backend's deterministic `rate_site()` over the cached Earth Engine metrics in
 * `backend/data/demo_sites` (baseline + Time Machine scenarios). Names of communities and
 * people are fictional sandbox personas.
 */
import raw from "./sites.json";

export type Grade = "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "C" | "D";
export type ScenarioKey = "baseline" | "restoration" | "encroachment";
export type LandcoverKey =
  | "water"
  | "trees"
  | "grass"
  | "flooded_vegetation"
  | "crops"
  | "shrub_and_scrub"
  | "built"
  | "bare";
export type ServiceKey =
  | "food_and_materials"
  | "water_supply"
  | "climate_regulation"
  | "flood_and_hazard_regulation"
  | "pollution_and_soil"
  | "habitat_and_biodiversity"
  | "recreation_and_culture"
  | "existence_and_bequest";

export type LatLng = [number, number];

export type ScenarioData = {
  period: string;
  landcover: Record<LandcoverKey, number>;
  ndvi: [string, number][];
  ndviTrend: number;
  ndviP: number;
  ndviMean: number;
  waterChange: number;
  biomass: number;
  forestLossHa: number;
  forestLoss12mHa: number;
  naturalFraction: number;
  components: Record<string, number>;
  health: number;
  grade: Grade;
  confidence: number;
  confidenceComponents: Record<
    "coverage" | "agreement" | "evidence" | "recency",
    number
  >;
  gatePassed: boolean;
  gateReasons: string[];
  valueLow: number;
  valueMid: number;
  valueHigh: number;
  services: Record<ServiceKey, number>;
  carbon: { stock: number; seq: number };
  fairValuePerUnit: number;
  flags: string[];
  description: string | null;
};

export type SiteData = {
  key: string;
  name: string;
  areaHa: number;
  centroid: LatLng;
  polygon: LatLng[];
  overlayBounds: [LatLng, LatLng];
  legend: { key: string; label: string; color: string }[];
  thumbnail: {
    w: number;
    h: number;
    window: { start: string; end: string };
  } | null;
  scenarios: Record<ScenarioKey, ScenarioData>;
};

export const SITE_DATA = (raw as unknown as { sites: SiteData[] }).sites;

export type Ecosystem = "Wetland" | "Mangrove" | "Forest";

export type SiteMeta = {
  id: string;
  key: string;
  ecosystem: Ecosystem;
  place: string;
  region: string;
  community: string;
  description: string;
  /** Sandbox world: listed before the visit, or a draft the steward lists during the demo. */
  initiallyListed: boolean;
  /** The steward persona's own community. */
  stewardOwned: boolean;
};

export const SITE_META: SiteMeta[] = [
  {
    id: "xochimilco-wetland",
    key: "wetland_mx",
    ecosystem: "Wetland",
    place: "Xochimilco, Mexico City",
    region: "Mexico City, Mexico",
    community: "Xochimilco Wetland Cooperative",
    description:
      "Canals, chinampa plots and willow-lined marsh at the southern edge of Mexico City. The cooperative keeps the canals flowing and the plots farmed by hand, next to a growing industrial zone.",
    initiallyListed: false,
    stewardOwned: true,
  },
  {
    id: "celestun-mangrove",
    key: "mangrove_mx",
    ecosystem: "Mangrove",
    place: "Ría Celestún, Yucatán",
    region: "Yucatán, Mexico",
    community: "Celestún Mangrove Collective",
    description:
      "A coastal mangrove lagoon on the Gulf of Mexico. Fishing families monitor the tidal channels and replant mangrove on cleared patches.",
    initiallyListed: true,
    stewardOwned: false,
  },
  {
    id: "sumidero-forest",
    key: "restoration_forest",
    ecosystem: "Forest",
    place: "Sumidero Canyon, Chiapas",
    region: "Chiapas, Mexico",
    community: "Sumidero Restoration Ejido",
    description:
      "Dry tropical forest and scrub above the Grijalva river canyon, recovering from past clearing. The ejido runs fire breaks and native tree nurseries.",
    initiallyListed: true,
    stewardOwned: false,
  },
];

export function siteDataFor(key: string): SiteData {
  const site = SITE_DATA.find((s) => s.key === key);
  if (!site) throw new Error(`Unknown demo site ${key}`);
  return site;
}

export const LANDCOVER_ORDER: LandcoverKey[] = [
  "trees",
  "water",
  "flooded_vegetation",
  "grass",
  "shrub_and_scrub",
  "crops",
  "built",
  "bare",
];

/** Dynamic World's own class colours, so the bar matches the map overlay. */
export const LANDCOVER: Record<LandcoverKey, { label: string; color: string }> =
  {
    water: { label: "Water", color: "#419bdf" },
    trees: { label: "Trees", color: "#397d49" },
    grass: { label: "Grass", color: "#88b053" },
    flooded_vegetation: { label: "Flooded vegetation", color: "#7a87c6" },
    crops: { label: "Crops", color: "#e49635" },
    shrub_and_scrub: { label: "Shrub and scrub", color: "#dfc35a" },
    built: { label: "Built", color: "#c4281b" },
    bare: { label: "Bare", color: "#a59b8f" },
  };

/** Eight valuation groups, folded into five headline services for the report card. */
export const SERVICE_GROUPS: {
  key: string;
  label: string;
  parts: ServiceKey[];
}[] = [
  { key: "water", label: "Water supply", parts: ["water_supply"] },
  {
    key: "flood",
    label: "Flood and pollution control",
    parts: ["flood_and_hazard_regulation", "pollution_and_soil"],
  },
  {
    key: "habitat",
    label: "Habitat and biodiversity",
    parts: ["habitat_and_biodiversity", "existence_and_bequest"],
  },
  {
    key: "recreation",
    label: "Recreation and culture",
    parts: ["recreation_and_culture", "food_and_materials"],
  },
  { key: "carbon", label: "Climate regulation", parts: ["climate_regulation"] },
];

export const SCORE_COMPONENTS: {
  key: string;
  label: string;
  /** How a low score on this component reads in a sentence. */
  issue: string;
  weight: number;
}[] = [
  {
    key: "vegetation_vigor",
    label: "Vegetation vigour",
    issue: "vegetation vigour",
    weight: 0.3,
  },
  {
    key: "natural_cover",
    label: "Natural cover",
    issue: "natural cover",
    weight: 0.25,
  },
  {
    key: "habitat_loss",
    label: "No habitat loss",
    issue: "habitat loss",
    weight: 0.2,
  },
  {
    key: "water_stability",
    label: "Water stability",
    issue: "water stability",
    weight: 0.15,
  },
  {
    key: "threat_pressure",
    label: "Low threat pressure",
    issue: "threat pressure from news",
    weight: 0.1,
  },
];

export const DATA_ATTRIBUTIONS = [
  "Land cover: Dynamic World (Google, National Geographic Society, World Resources Institute)",
  "Contains modified Copernicus Sentinel data 2021–2026",
  "Surface water: EC JRC / Google, Pekel et al. 2016",
  "Forest change: Hansen et al. 2013",
  "Biomass: ESA CCI Biomass v6.0; GEDI L4B",
  "Mangroves: Global Mangrove Watch v3.0 (CC BY 4.0)",
  "Soil carbon: SoilGrids 2.0 (CC BY 4.0)",
];

export const QUARTERS = ["2026Q3", "2026Q4", "2027Q1"] as const;
export const QUARTER_DATES = ["2026-10-15", "2027-01-15", "2027-04-15"];

export const MODELS = {
  orchestrator: {
    name: "Nemotron 3 Super",
    id: "nvidia/nemotron-3-super-120b-a12b",
    price: [0.3, 0.9],
  },
  fast: {
    name: "Nemotron 3 Nano",
    id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    price: [0.06, 0.24],
  },
  auditor: {
    name: "Nemotron 3 Ultra",
    id: "nvidia/Nemotron-3-Ultra-550b-a55b",
    price: [1, 3],
  },
  vision: {
    name: "Nemotron 3.5 Super VL",
    id: "nvidia/Nemotron-3.5-Super-VL",
    price: [0.3, 0.9],
  },
} as const;
