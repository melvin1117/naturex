import type { Metadata } from "next";

import { JudgeStory } from "@/components/story/judge-story";

export const metadata: Metadata = {
  title: "Why WildWorth · try it, no sign-up",
  description:
    "The bees never sent an invoice. WildWorth works out what they're worth. See it on one real wetland, then try it in your own sandbox. Sandbox · play money only.",
};

export default function JudgePage() {
  return <JudgeStory />;
}
