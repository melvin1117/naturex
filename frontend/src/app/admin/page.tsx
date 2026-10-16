import type { Metadata } from "next";

import { ControlRoom } from "@/components/proto/control-room";

export const metadata: Metadata = { title: "Time Machine" };

export default function AdminPage() {
  return <ControlRoom />;
}
