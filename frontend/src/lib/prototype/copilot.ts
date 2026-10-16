/**
 * Prototype Copilot: scripted, grounded answers composed from the sandbox world, with
 * citations to the report, news events and ledger. T39 replaces this with Nemotron 3 Nano + RAG.
 */
import { GRADE_LABEL, money, pct, price, signedPct } from "./format";
import { SCORE_COMPONENTS, SERVICE_GROUPS, siteDataFor } from "./data";
import { latestReport, previousReport, type World } from "./world";

export type CopilotAnswer = {
  text: string;
  citations: { label: string; href: string }[];
};

export const SUGGESTED_QUESTIONS = [
  "Why did the price change?",
  "What drives this grade?",
  "How is the value estimated?",
  "How sure is this rating?",
];

export function answer(
  world: World,
  question: string,
  siteId: string | null,
): CopilotAnswer {
  const q = question.toLowerCase();
  const site =
    world.sites.find((s) => s.id === siteId) ??
    world.sites.find((s) => q.includes(s.name.toLowerCase().split(" ")[0])) ??
    world.sites.find(
      (s) => s.id === "xochimilco-wetland" && s.reports.length,
    ) ??
    world.sites.find((s) => s.reports.length);
  if (!site) {
    return {
      text: "No site has a rating yet. List a site or open one from the Marketplace, then ask again.",
      citations: [],
    };
  }
  const report = latestReport(site);
  if (!report) {
    return {
      text: `${site.name} hasn't been rated yet, so there's nothing to explain. Ratings start when the community submits the listing.`,
      citations: [],
    };
  }
  const prev = previousReport(site);
  const href = `/asset/${site.id}`;
  const reportCite = {
    label: `Report v${report.version}`,
    href: `${href}?tab=report`,
  };
  const events = world.events.filter((e) => e.siteId === site.id);
  const latestNeg = [...events].reverse().find((e) => e.direction < 0);

  if (/(sure|confiden|certain|trust)/.test(q)) {
    const c = report.confidenceComponents;
    return {
      text: `Confidence is ${pct(report.confidence)}. It weighs satellite coverage (${pct(c.coverage * 100)}, 40%), agreement between satellite and news (${pct(c.agreement * 100)}, 30%), field evidence (${c.evidence === 1 ? "validated photos" : "none yet"}, 20%) and data recency (${pct(c.recency * 100)}, 10%). ${c.evidence < 1 ? "Geotagged photos from the community would raise it." : ""}`,
      citations: [reportCite],
    };
  }

  if (/(why|drop|fell|fall|down|change|price|move|downgrad)/.test(q)) {
    if (prev && report.health !== prev.health) {
      const dir = report.health < prev.health ? "fell" : "rose";
      const cites = [
        reportCite,
        { label: `Report v${prev.version}`, href: `${href}?tab=report` },
      ];
      const parts = [
        `${site.name}'s health ${dir} from ${prev.health.toFixed(1)} to ${report.health.toFixed(1)} (${prev.grade} → ${report.grade}).`,
      ];
      if (report.scenario === "encroachment") {
        const built = (
          (report.landcover.built - prev.landcover.built) *
          100
        ).toFixed(1);
        parts.push(
          `Satellite land cover shows built-up land up ${built} percentage points and surface water change at ${report.waterChange.toFixed(1)}.`,
        );
        if (latestNeg) {
          parts.push(
            `That matches a news report: "${latestNeg.title}" (severity ${latestNeg.severity} of 5).`,
          );
          cites.push({ label: "News event", href: `${href}?tab=news` });
        }
        if (report.adjustment)
          parts.push(
            `The Auditor lowered health a further ${Math.abs(report.adjustment).toFixed(1)} points because the newest months aren't in the land-cover window yet.`,
          );
      } else if (report.scenario === "restoration") {
        parts.push(
          `${siteDataFor(site.key).scenarios.restoration.description ?? "Restoration work shows in the latest satellite data."} That lifts vegetation vigour and water stability.`,
        );
      }
      const first = site.prices[0]?.price;
      if (first)
        parts.push(
          `The stake price re-anchors toward the new fair price of ${price(report.fairValuePerUnit)}; it is ${signedPct(((site.price - first) / first) * 100)} since the opening offer. Play money only.`,
        );
      return { text: parts.join(" "), citations: cites };
    }
    return {
      text: `${site.name} hasn't been re-rated since v${report.version}, so its grade hasn't changed. Day-to-day moves in the stake price come from orders and small drift toward the fair price of ${price(report.fairValuePerUnit)}.`,
      citations: [reportCite],
    };
  }

  if (/(value|worth|dollar|\$|estimat|service)/.test(q)) {
    const groups = SERVICE_GROUPS.map((g) => ({
      label: g.label,
      v: g.parts.reduce((sum, k) => sum + report.services[k], 0),
    })).sort((a, b) => b.v - a.v);
    return {
      text: `Ecosystem services are estimated at ${money(report.valueLow)}–${money(report.valueHigh)} a year (mid ${money(report.valueMid)}), using published per-hectare values for each land-cover type (Brander et al. 2024, Costanza et al. 2014). The largest parts are ${groups[0].label.toLowerCase()} (${money(groups[0].v)}) and ${groups[1].label.toLowerCase()} (${money(groups[1].v)}). It's a screening estimate, not a certified appraisal.`,
      citations: [reportCite],
    };
  }

  const weakest = SCORE_COMPONENTS.map((c) => ({
    label: c.issue,
    value: report.components[c.key] ?? 0,
  })).reduce((a, b) => (b.value < a.value ? b : a));
  return {
    text: `${site.name} is rated ${report.grade} (${GRADE_LABEL[report.grade].toLowerCase()}), health ${report.health.toFixed(1)}. The score weighs vegetation vigour (30%), natural cover (25%), habitat loss (20%), water stability (15%) and threat pressure (10%). Its weakest part is ${weakest.label}, scoring ${Math.round(weakest.value * 100)} out of 100. The formula sets the number; the Auditor can only adjust it within ±10 with cited evidence.`,
    citations: [
      reportCite,
      { label: "Nature Ledger", href: `${href}?tab=ledger` },
    ],
  };
}
