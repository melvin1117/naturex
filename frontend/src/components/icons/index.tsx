import {
  createLucideIcon,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { forwardRef } from "react";
import { cn } from "cn";

import { BeaDrawing } from "@/components/bea/bea-drawing";

import { DRAWINGS, type DrawingKey } from "./drawings";

/** The brand's stroke (guidelines ch. 8): 1.75 px on Lucide's 24-px grid. */
export const BRAND_STROKE = 1.75;

/**
 * One WildWorth icon: the guidelines' drawing, with Lucide's props (`size`, `color`,
 * `strokeWidth`, `absoluteStrokeWidth`, `className`, SVG attributes) and its accessibility
 * defaults (hidden unless labelled). Each icon lights one part: `.af` fills lime with an ink
 * outline, `.as` strokes lime-ink (lime on the machine layer), `.f` fills with the ink.
 */
function brandIcon(key: DrawingKey, displayName: string): LucideIcon {
  const Base = createLucideIcon(`ww-${key}`, [...DRAWINGS[key]]);
  const Icon = forwardRef<SVGSVGElement, LucideProps>(function BrandIcon(
    { strokeWidth = BRAND_STROKE, className, ...props },
    ref,
  ) {
    return (
      <Base
        ref={ref}
        strokeWidth={strokeWidth}
        className={cn("ww-icon", className)}
        {...props}
      />
    );
  });
  Icon.displayName = displayName;
  return Icon;
}

export const ProofOfLifeIcon = brandIcon("proof", "ProofOfLifeIcon");
export const HealthScoreIcon = brandIcon("health", "HealthScoreIcon");
export const WorthRangeIcon = brandIcon("worth", "WorthRangeIcon");
export const WildWatchIcon = brandIcon("wildwatch", "WildWatchIcon");
export const RecordIcon = brandIcon("record", "RecordIcon");
export const AgentTraceIcon = brandIcon("trace", "AgentTraceIcon");
export const AuditorIcon = brandIcon("auditor", "AuditorIcon");
export const NewsScoutIcon = brandIcon("news", "NewsScoutIcon");
export const SatelliteRecordIcon = brandIcon(
  "satellite",
  "SatelliteRecordIcon",
);
export const LiveIcon = brandIcon("live", "LiveIcon");
export const TimeMachineIcon = brandIcon("time", "TimeMachineIcon");
export const ListLandIcon = brandIcon("list", "ListLandIcon");
export const FieldEvidenceIcon = brandIcon("evidence", "FieldEvidenceIcon");
export const VerifiedLandIcon = brandIcon("verify", "VerifiedLandIcon");
export const OpeningOfferIcon = brandIcon("offer", "OpeningOfferIcon");
export const BackThisSiteIcon = brandIcon("back", "BackThisSiteIcon");
export const YourStakesIcon = brandIcon("stakes", "YourStakesIcon");
export const CommunityFundIcon = brandIcon("fund", "CommunityFundIcon");
export const ExchangeIcon = brandIcon("exchange", "ExchangeIcon");
export const StewardsIcon = brandIcon("stewards", "StewardsIcon");
export const ControlRoomIcon = brandIcon("control", "ControlRoomIcon");
export const AskBeaIcon = brandIcon("ask", "AskBeaIcon");
export const AlertsIcon = brandIcon("alerts", "AlertsIcon");
export const RecoveryPlanIcon = brandIcon("recovery", "RecoveryPlanIcon");
export const GuidedTourIcon = brandIcon("tour", "GuidedTourIcon");
export const RatedSitesIcon = brandIcon("sites", "RatedSitesIcon");
export const SandboxIcon = brandIcon("sandbox", "SandboxIcon");
export const CarbonIcon = brandIcon("carbon", "CarbonIcon");
export const WaterIcon = brandIcon("water", "WaterIcon");
export const FloodIcon = brandIcon("flood", "FloodIcon");
export const HabitatIcon = brandIcon("habitat", "HabitatIcon");
export const RecreationIcon = brandIcon("recreation", "RecreationIcon");

/**
 * Bea's icon is her drawing scaled down (`viewBox="10 12 100 100"`), so the icon and the
 * character always match. Same props as the others; she keeps her own line weight.
 */
export const BeaIcon = forwardRef<SVGSVGElement, LucideProps>(function BeaIcon(
  { size = 24, color = "currentColor", className, ...props },
  ref,
) {
  // Bea keeps her own line weight: Lucide's stroke props don't apply to her drawing.
  const svg: Omit<LucideProps, "size" | "color" | "className"> = { ...props };
  delete svg.strokeWidth;
  delete svg.absoluteStrokeWidth;
  delete svg.nonScalingStroke;
  const labelled =
    props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="10 12 100 100"
      fill="none"
      color={color}
      className={cn("lucide ww-icon ww-bea", className)}
      {...(labelled ? { role: "img" } : { "aria-hidden": true })}
      {...svg}
    >
      <BeaDrawing state="neutral" />
    </svg>
  );
});

/** Every icon by its key in the guidelines (`GL`), for the UI kit and tests. */
export const BRAND_ICONS: Record<DrawingKey | "bea", LucideIcon> = {
  proof: ProofOfLifeIcon,
  health: HealthScoreIcon,
  worth: WorthRangeIcon,
  wildwatch: WildWatchIcon,
  record: RecordIcon,
  trace: AgentTraceIcon,
  auditor: AuditorIcon,
  news: NewsScoutIcon,
  satellite: SatelliteRecordIcon,
  live: LiveIcon,
  time: TimeMachineIcon,
  list: ListLandIcon,
  evidence: FieldEvidenceIcon,
  verify: VerifiedLandIcon,
  offer: OpeningOfferIcon,
  back: BackThisSiteIcon,
  stakes: YourStakesIcon,
  fund: CommunityFundIcon,
  exchange: ExchangeIcon,
  stewards: StewardsIcon,
  control: ControlRoomIcon,
  bea: BeaIcon as LucideIcon,
  ask: AskBeaIcon,
  alerts: AlertsIcon,
  recovery: RecoveryPlanIcon,
  tour: GuidedTourIcon,
  sites: RatedSitesIcon,
  sandbox: SandboxIcon,
  carbon: CarbonIcon,
  water: WaterIcon,
  flood: FloodIcon,
  habitat: HabitatIcon,
  recreation: RecreationIcon,
};
