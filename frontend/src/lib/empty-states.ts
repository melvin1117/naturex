/**
 * Empty-state copy that teaches (WP4, #216; ux-writing §8): what will appear, what makes it
 * appear and, where there is one, the next action. It must never contradict the screen, and
 * claims nothing it can't know.
 */

/** The Agent Trace away from a site, before any model call is logged in the world. */
export const MODEL_CALLS_EMPTY = {
  title: "No model calls logged in this world yet",
  body: "Live ratings log their model calls here, with tokens and time. Mock ratings don't call a model, and a rating that falls back to the fixed pipeline may not either.",
} as const;

type SiteCard = {
  id: string;
  name: string;
  site_key?: string | null;
  grade?: string | null;
  status?: string;
};

/** A curated demo site that has a rating, whose "How it was rated" the trace can point to. */
export function curatedSite<T extends SiteCard>(
  cards: readonly T[] | undefined,
): T | null {
  const rated = (cards ?? []).filter((c) => c.site_key && c.grade);
  return rated.find((c) => c.status === "listed") ?? rated[0] ?? null;
}

/** A Time Machine quarter that ran with no listed site to re-rate. */
export const QUARTER_NO_SITES =
  "No site was listed in this world, so the quarter re-rated nothing. Once a community lists land, each quarter re-rates it here.";
