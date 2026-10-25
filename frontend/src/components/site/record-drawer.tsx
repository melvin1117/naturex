"use client";

import { FieldEvidencePanel } from "@/components/evidence/field-evidence-panel";
import { ApiLedgerTab } from "@/components/proto/ledger-panels";
import { ReportTab, ScorePanel } from "@/components/proto/report-panels";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VerificationPanel } from "@/components/verification/verification-panel";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, SiteImages } from "@/lib/api/types";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import type { AssetLandCover } from "@/lib/land-cover-overlay";
import { quarterLabel } from "@/lib/prototype/format";
import type { ReportFacts } from "@/lib/report-facts";
import {
  RECORD_TAB_LABEL,
  RECORD_TABS,
  type RecordTab,
} from "@/lib/site-drawer";

/**
 * Everything behind a site's rating, over its page (ADR-0008): the Proof of Life report and how
 * its score is built, The Record, how the listing was verified, field photos and the data
 * credits. `?tab=` names the tab, so links into the report or a ledger entry land here.
 */
export function RecordDrawer({
  tab,
  onTab,
  onClose,
  asset,
  latest,
  versions,
  versionParam,
  reportsError,
  images,
  landCover,
}: {
  tab: RecordTab | null;
  onTab: (tab: RecordTab) => void;
  onClose: () => void;
  asset: AssetDetail;
  latest: ReportFacts | null;
  versions: ReportFacts[];
  versionParam: number | null;
  reportsError: ApiError | null;
  images: SiteImages | undefined;
  landCover: AssetLandCover | null;
}) {
  return (
    <Sheet open={tab !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto overscroll-contain bg-background p-0 sm:max-w-3xl"
      >
        <Tabs
          value={tab ?? "report"}
          onValueChange={(v) => onTab(v as RecordTab)}
          className="gap-0"
        >
          <SheetHeader className="gap-1 border-b border-border/70 bg-card px-5 pt-7 pb-0 sm:px-8">
            <SheetTitle className="pr-8 font-serif text-3xl font-normal tracking-tight">
              {asset.name}
            </SheetTitle>
            <SheetDescription>
              {latest
                ? `Proof of Life v${latest.version}${latest.period ? ` · ${quarterLabel(latest.period)}` : ""}, and everything behind it.`
                : "Everything behind this site's rating."}
            </SheetDescription>
            <div className="-mx-5 mt-4 overflow-x-auto px-5 sm:-mx-8 sm:px-8">
              <TabsList className="h-auto w-max gap-1 rounded-none bg-transparent p-0">
                {RECORD_TABS.map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="rounded-none border-0 border-b-2 border-transparent px-3 pt-1 pb-3 text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    {RECORD_TAB_LABEL[t]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </SheetHeader>
          <div className="px-5 pt-6 pb-12 sm:px-8">
            <TabsContent value="report" className="space-y-6">
              {latest ? (
                <>
                  {reportsError && (
                    <p role="alert" className="text-sm text-muted-foreground">
                      Showing the latest report only: {reportsError.message}
                    </p>
                  )}
                  <ReportTab
                    versions={versions}
                    siteName={asset.name}
                    initialVersion={versionParam}
                    live
                  />
                  <ScorePanel facts={latest} />
                </>
              ) : (
                <p className="text-muted-foreground">
                  This site hasn&apos;t been rated yet.
                </p>
              )}
            </TabsContent>
            <TabsContent value="ledger">
              <ApiLedgerTab assetId={asset.id} />
            </TabsContent>
            <TabsContent value="verification">
              <VerificationPanel assetId={asset.id} />
            </TabsContent>
            <TabsContent value="photos">
              <FieldEvidencePanel
                assetId={asset.id}
                communityId={asset.community_id ?? null}
              />
            </TabsContent>
            <TabsContent value="sources">
              <DataSources
                facts={latest}
                images={images}
                landCover={landCover}
                views={asset.site_views?.attributions}
              />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function DataSources({
  facts,
  images,
  landCover,
  views,
}: {
  facts: ReportFacts | null;
  images: SiteImages | undefined;
  landCover: AssetLandCover | null;
  /** A live listing's before/after views (`site_views`). */
  views?: string[];
}) {
  const lines = [
    ...new Set([
      ...(facts?.attributions ?? []),
      ...(landCover?.attributions ?? []),
      ...(images?.thumbnail?.attributions ?? []),
      ...(views ?? []),
      IMAGERY_ATTRIBUTION,
    ]),
  ];
  return (
    <section
      aria-labelledby="data-sources"
      className="text-sm text-muted-foreground"
    >
      <h2 id="data-sources" className="font-medium text-foreground">
        Data behind this page
        {facts?.period && ` · ${quarterLabel(facts.period)} report`}
      </h2>
      <ul className="mt-3 space-y-2 leading-relaxed">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-4">
        Values are screening estimates from published benefit-transfer
        coefficients, not appraisals.
      </p>
    </section>
  );
}
