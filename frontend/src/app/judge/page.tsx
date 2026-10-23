import type { Metadata } from "next";

import { JudgeStory } from "@/components/story/judge-story";

export const metadata: Metadata = {
  title: "Why NatureX · try it, no sign-up",
};

export default function JudgePage() {
  return <JudgeStory />;
}
