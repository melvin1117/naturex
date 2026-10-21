/**
 * Empty-state copy that teaches (WP4, #216; ux-writing §6): what will appear, what makes it
 * appear and, where there is one, the next action. It must never contradict the screen, so
 * the steward home's copy depends on whether its sites are rated yet.
 */

type ListingFacts = {
  report_version: number | null;
  ipo_at: string | null;
  asset: { mock?: boolean };
};

/** The steward home's "Stewardship actions" panel with no recommendation to show. */
export function recommendationsEmptyText(listings: readonly ListingFacts[]) {
  const rated = listings.filter((l) => l.report_version !== null);
  if (rated.length === 0)
    return "Stewardship actions appear after a site's first rating: concrete steps from the Auditor that would strengthen its grade.";
  if (rated.every((l) => l.asset.mock))
    return "Mock ratings don't include the Auditor's recommendations. A live rating lists concrete steps here that would strengthen the grade.";
  return "The Auditor's latest report suggests no stewardship actions. Its next review comes with the next rating.";
}

/** The steward home's "Quarterly payouts" panel before any payout. */
export function payoutsEmptyText(listings: readonly ListingFacts[]) {
  if (listings.some((l) => l.ipo_at !== null))
    return "The first payout comes when the next quarter runs: half of the simulated revenue goes to the community fund and half to the units' holders, the treasury included.";
  return "Payouts start after a site's opening offer. Each quarter, half of the simulated revenue goes to the community fund and half to the units' holders, the treasury included.";
}

/** The Agent Trace away from a site, before any model call is logged in the world. */
export const MODEL_CALLS_EMPTY = {
  title: "No model calls logged in this world yet",
  body: "Each live rating logs its Nemotron calls here, with tokens and time. Ratings in mock mode don't call a model, so they log none.",
} as const;

/** A Time Machine quarter that ran with no listed site to re-rate. */
export const QUARTER_NO_SITES =
  "No site was listed in this world, so the quarter re-rated nothing. Once a community lists land, each quarter re-rates it here.";
