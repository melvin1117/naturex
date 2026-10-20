import type { Metadata } from "next";

import { ListingScreen } from "@/components/listing/listing-screen";

export const metadata: Metadata = { title: "List your land" };

export default function ListPage() {
  return <ListingScreen />;
}
