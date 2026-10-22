import type { Metadata } from "next";

import { ControlRoom } from "@/components/trace/control-room";

export const metadata: Metadata = { title: "The AI at work" };

export default function AiPage() {
  return <ControlRoom />;
}
