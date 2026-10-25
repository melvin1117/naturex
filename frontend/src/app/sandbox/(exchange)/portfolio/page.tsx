import type { Metadata } from "next";

import { PortfolioScreen } from "@/components/portfolio-view";

export const metadata: Metadata = { title: "Your stakes" };

export default function PortfolioPage() {
  return <PortfolioScreen />;
}
