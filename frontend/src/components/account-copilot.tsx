"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import type { BeaState } from "@/components/bea/bea";
import {
  BeaSheetTitle,
  SITE_SUBTITLE,
  WORLD_SUBTITLE,
} from "@/components/bea/bea-sheet-title";
import { CopilotChat } from "@/components/copilot-chat";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SheetHeader } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAsset, useAssets } from "@/lib/hooks";

type Scope = "world" | "site";

/**
 * Bea in the header's sheet for a signed-in account (#213; was the Copilot): her real answers
 * (`POST /copilot`, streamed and cited). It asks across every site by default; opened on a site's
 * page it starts on that site, one tap from "All sites". Narrowing to another site is optional.
 * Mounted only while the sheet is open, so each opening starts from the current page; if the
 * page's site changes while it's open (browser Back), the scope follows it. The scope is locked
 * while an answer streams.
 */
export function AccountCopilot({
  pageAssetId,
  onNavigate,
}: {
  pageAssetId: string | null;
  onNavigate: () => void;
}) {
  const [siteId, setSiteId] = useState<string | null>(pageAssetId);
  const [scope, setScope] = useState<Scope>(pageAssetId ? "site" : "world");
  const [page, setPage] = useState(pageAssetId);
  const [pending, setPending] = useState(false);
  const [bea, setBea] = useState<BeaState>("hello");
  if (page !== pageAssetId) {
    setPage(pageAssetId);
    setSiteId(pageAssetId);
    setScope(pageAssetId ? "site" : "world");
  }
  const site = useAsset(siteId ?? undefined);
  const assets = useAssets();
  const rated = (assets.data ?? []).filter((a) => a.grade);
  const siteName =
    site.data?.name ?? rated.find((a) => a.id === siteId)?.name ?? null;
  const scoped = scope === "site" && siteId !== null;

  return (
    <>
      <SheetHeader className="gap-3.5 border-b bg-card px-5 pt-5 pb-4">
        <BeaSheetTitle
          state={bea}
          subtitle={scoped ? SITE_SUBTITLE : WORLD_SUBTITLE}
        />
        {(siteId || rated.length > 0) && (
          <div className="flex min-w-0 items-center gap-2">
            {siteId && (
              <ToggleGroup
                type="single"
                value={scope}
                onValueChange={(v) =>
                  (v === "world" || v === "site") && setScope(v)
                }
                className="min-w-0 flex-1 rounded-full bg-background p-0.5"
                aria-label="Ask about"
                disabled={pending}
              >
                <ToggleGroupItem
                  value="site"
                  className="h-8 min-w-0 flex-1 rounded-full px-3 text-[13px] data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <span className="truncate">{siteName ?? "This site"}</span>
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="world"
                  className="h-8 shrink-0 rounded-full px-3 text-[13px] data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  All sites
                </ToggleGroupItem>
              </ToggleGroup>
            )}
            {rated.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    aria-label={
                      siteId ? "Ask about another site" : "Narrow to one site"
                    }
                    className={
                      siteId
                        ? "shrink-0 gap-1 px-2.5 text-[13px] text-muted-foreground"
                        : "-ml-2.5 w-fit gap-1 px-2.5 text-[13px] text-muted-foreground"
                    }
                  >
                    {siteId ? "Another site" : "Narrow to one site"}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-72 w-64 overflow-y-auto"
                >
                  <DropdownMenuLabel>Ask about one site</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={scoped ? siteId : ""}
                    onValueChange={(v) => {
                      setSiteId(v);
                      setScope("site");
                    }}
                  >
                    {rated.map((a) => (
                      <DropdownMenuRadioItem key={a.id} value={a.id}>
                        {a.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </SheetHeader>
      {scoped ? (
        <CopilotChat
          variant="sheet"
          assetId={siteId}
          assetName={siteName ?? "this site"}
          onNavigate={onNavigate}
          onPendingChange={setPending}
          onBeaStateChange={setBea}
        />
      ) : (
        <CopilotChat
          variant="sheet"
          onNavigate={onNavigate}
          onPendingChange={setPending}
          onBeaStateChange={setBea}
        />
      )}
    </>
  );
}
