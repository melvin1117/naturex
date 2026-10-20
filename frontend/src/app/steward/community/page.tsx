import type { Metadata } from "next";

import { CommunitySettings } from "@/components/steward/community-settings";

export const metadata: Metadata = { title: "Community settings" };

export default function CommunityPage() {
  return <CommunitySettings />;
}
