import type { Metadata } from "next";

import { ListingsRoute } from "@/components/steward/listings-page";

export const metadata: Metadata = { title: "Listings" };

export default function ListingsPage() {
  return <ListingsRoute />;
}
