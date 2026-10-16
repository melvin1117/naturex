import type { Metadata } from "next";

import { Portfolio } from "@/components/proto/portfolio";

export const metadata: Metadata = { title: "Your stakes" };

export default function PortfolioPage() {
  return <Portfolio />;
}
