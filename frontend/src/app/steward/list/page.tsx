import type { Metadata } from "next";

import { ListingFlow } from "@/components/proto/listing-flow";

export const metadata: Metadata = { title: "List your land" };

export default function ListPage() {
  return <ListingFlow />;
}
