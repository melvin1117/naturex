import type { LucideIcon, LucideProps } from "lucide-react";

import {
  AgentTraceIcon,
  ControlRoomIcon,
  ExchangeIcon,
  ListLandIcon,
  RatedSitesIcon,
  StewardsIcon,
  TimeMachineIcon,
  VerifiedLandIcon,
  YourStakesIcon,
} from "@/components/icons";
import type { AppKey } from "@/lib/navigation";

const APP_ICON: Record<AppKey, LucideIcon> = {
  exchange: ExchangeIcon,
  steward: StewardsIcon,
  admin: ControlRoomIcon,
};

/** Each page in the apps' navigation, by its href (guidelines ch. 8: icons always labelled). */
const PAGE_ICON: Record<string, LucideIcon> = {
  "/": RatedSitesIcon,
  "/portfolio": YourStakesIcon,
  "/ai": AgentTraceIcon,
  "/steward": StewardsIcon,
  "/steward/listings": RatedSitesIcon,
  "/steward/list": ListLandIcon,
  "/admin": TimeMachineIcon,
  "/admin/verifications": VerifiedLandIcon,
};

export function AppIcon({ app, ...props }: { app: AppKey } & LucideProps) {
  const Icon = APP_ICON[app];
  return <Icon aria-hidden="true" {...props} />;
}

export function PageIcon({ href, ...props }: { href: string } & LucideProps) {
  const Icon = PAGE_ICON[href];
  return Icon ? <Icon aria-hidden="true" {...props} /> : null;
}
