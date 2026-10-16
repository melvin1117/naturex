import type { Metadata } from "next";

import { JudgeLanding } from "@/components/proto/judge-landing";

export const metadata: Metadata = { title: "Try the demo" };

export default function JudgePage() {
  return <JudgeLanding />;
}
