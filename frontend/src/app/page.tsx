import type { Metadata } from "next";

import { Welcome } from "@/components/welcome/welcome";

export const metadata: Metadata = {
  title: { absolute: "WildWorth · nature ratings" },
};

export default function HomePage() {
  return <Welcome />;
}
