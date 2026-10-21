"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";

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
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAsset, useAssets } from "@/lib/hooks";

type Scope = "world" | "site";

/**
 * The header Copilot for a signed-in account (#213): the real Copilot (`POST /copilot`,
 * streamed and cited) in the sheet. It asks across every site by default; opened on a site's
 * page it starts on that site, one tap from "All sites". Narrowing to another site is optional.
 * Mounted only while the sheet is open, so each opening starts from the current page.
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
  const site = useAsset(siteId ?? undefined);
  const assets = useAssets();
  const rated = (assets.data ?? []).filter((a) => a.grade);
  const siteName =
    site.data?.name ?? rated.find((a) => a.id === siteId)?.name ?? null;
  const scoped = scope === "site" && siteId !== null;

  return (
    <>
      <SheetHeader className="gap-3 border-b px-6 pt-6 pb-4">
        <div className="space-y-1.5">
          <SheetTitle className="font-serif text-3xl font-normal">
            Copilot
          </SheetTitle>
          <SheetDescription>
            Answers come only from the sites&apos; reports and news, and link
            every claim to its source. Play money only; not advice.
          </SheetDescription>
        </div>
        {siteId && (
          <ToggleGroup
            type="single"
            value={scope}
            onValueChange={(v) =>
              (v === "world" || v === "site") && setScope(v)
            }
            className="w-full max-w-full rounded-full bg-secondary p-1"
            aria-label="Ask about"
          >
            <ToggleGroupItem
              value="site"
              className="min-w-0 flex-1 rounded-full px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              <span className="truncate">{siteName ?? "This site"}</span>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="world"
              className="flex-1 rounded-full px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
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
                className="w-fit text-muted-foreground"
              >
                {siteId ? "Ask about another site" : "Narrow to one site"}
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
      </SheetHeader>
      {scoped ? (
        <CopilotChat
          variant="sheet"
          assetId={siteId}
          assetName={siteName ?? "this site"}
          onNavigate={onNavigate}
        />
      ) : (
        <CopilotChat variant="sheet" onNavigate={onNavigate} />
      )}
    </>
  );
}
