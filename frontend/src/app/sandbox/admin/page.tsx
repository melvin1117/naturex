import type { Metadata } from "next";

import { AdminScreen } from "@/components/time-machine/time-machine-screen";

export const metadata: Metadata = { title: "Time Machine" };

export default function AdminPage() {
  return <AdminScreen />;
}
