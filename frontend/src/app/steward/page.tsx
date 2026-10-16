import type { Metadata } from "next";

import { StewardHome } from "@/components/proto/steward-home";

export const metadata: Metadata = { title: "Community home" };

export default function StewardPage() {
  return <StewardHome />;
}
