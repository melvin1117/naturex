import type { Metadata } from "next";

import { StewardHomeRoute } from "@/components/steward/steward-home";

export const metadata: Metadata = { title: "Communities" };

export default function StewardPage() {
  return <StewardHomeRoute />;
}
