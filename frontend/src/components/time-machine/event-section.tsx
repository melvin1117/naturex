"use client";

import { TriangleAlertIcon, Zap } from "lucide-react";
import Link from "@/components/app-link";
import { useEffect, useState } from "react";

import { Panel } from "@/components/proto/report-panels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toApiError } from "@/lib/api/errors";
import type { AssetCard, EventPreset, SimulateEvent } from "@/lib/api/types";
import { quarterLabel } from "@/lib/prototype/format";
import { eventFailure, eventOutcomeText, eventTitle } from "@/lib/time-machine";
import { useSimulateEvent } from "@/lib/time-machine-hooks";

import { changeCells } from "./rating-change";
import { SentAlerts } from "./sent-alerts";

const HERO_SITE = "wetland_mx";

function PresetFacts({ preset }: { preset: EventPreset }) {
  return (
    <div className="rounded-2xl bg-muted/60 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{preset.label}</span>
        <Badge variant={preset.direction < 0 ? "destructive" : "secondary"}>
          {preset.direction < 0 ? "Harms nature" : "Helps nature"}
        </Badge>
        <Badge variant="outline">Severity {preset.severity} of 5</Badge>
        {preset.alerts && (
          <Badge variant="outline">Alerts holders as news</Badge>
        )}
      </div>
      <p className="mt-2 text-muted-foreground">{preset.description}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        That&apos;s the generic effect; a curated demo site may apply its own
        scripted version, shown with the result.
      </p>
    </div>
  );
}

function EventResult({
  result,
  name,
}: {
  result: SimulateEvent;
  name: string;
}) {
  const cells = changeCells(result.before, result.after);
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{eventTitle(result, name)}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {result.description}
        </p>
        <p className="mt-2 flex flex-wrap gap-2">
          <Badge variant="outline">Simulated · {result.data_version}</Badge>
          <Badge variant="secondary">{quarterLabel(result.period)}</Badge>
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 text-sm">
        <dt className="text-muted-foreground">Health</dt>
        <dd>{cells.health}</dd>
        <dt className="text-muted-foreground">Grade</dt>
        <dd>{cells.grade}</dd>
        <dt className="text-muted-foreground">Stake price</dt>
        <dd>{cells.price}</dd>
      </dl>
      <Button asChild variant="outline" size="sm">
        <Link href={`/asset/${result.event.asset_id}?tab=price`}>
          See it on the price chart
        </Link>
      </Button>
    </div>
  );
}

/** Pick a listed site and a preset, confirm, then see its before → after and alerts. */
export function EventSection({
  presets,
  assets,
  onRefresh,
  onPendingChange,
}: {
  presets: EventPreset[];
  /** Listed sites of this world. */
  assets: AssetCard[];
  onRefresh: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const inject = useSimulateEvent();
  const hero = assets.find((a) => a.site_key === HERO_SITE) ?? assets[0];
  const [assetId, setAssetId] = useState<string | undefined>(undefined);
  const [presetName, setPresetName] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  // What was asked for, so the progress names it even if the lists change meanwhile.
  const [requested, setRequested] = useState<{
    asset: string;
    preset: string;
  } | null>(null);
  const asset = assets.find((a) => a.id === assetId) ?? hero;
  const preset =
    presets.find((p) => p.preset === presetName) ??
    presets.find((p) => p.preset === "encroachment") ??
    presets[0];
  const failure = inject.error ? eventFailure(inject.error) : null;
  const resultName =
    assets.find((a) => a.id === inject.data?.event.asset_id)?.name ?? "";

  useEffect(() => {
    onPendingChange?.(inject.isPending);
    return () => onPendingChange?.(false);
  }, [inject.isPending, onPendingChange]);

  const run = async () => {
    if (!asset || !preset) return;
    setRequested({ asset: asset.name, preset: preset.label.toLowerCase() });
    try {
      await inject.mutateAsync({ asset_id: asset.id, preset: preset.preset });
    } catch (error) {
      if (eventFailure(toApiError(error)).refresh) onRefresh();
    }
  };

  return (
    <Panel title="Inject an event" headingLevel="h2">
      {assets.length === 0 || !asset || !preset ? (
        <p className="text-sm text-muted-foreground">
          No listed sites yet. Events can only be injected into a listed site.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="event-asset">Site</Label>
              <Select
                value={asset.id}
                onValueChange={setAssetId}
                disabled={inject.isPending}
              >
                <SelectTrigger id="event-asset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assets.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="event-preset">Event</Label>
              <Select
                value={preset.preset}
                onValueChange={setPresetName}
                disabled={inject.isPending}
              >
                <SelectTrigger id="event-preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.preset} value={p.preset}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <PresetFacts preset={preset} />
            <Dialog
              open={confirming}
              onOpenChange={(open) => setConfirming(open && !inject.isPending)}
            >
              <DialogTrigger asChild>
                {/* aria-disabled, not disabled, while it runs: the dialog hands focus back
                    here, and a disabled button would drop it to the page. */}
                <Button
                  aria-disabled={inject.isPending || undefined}
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-primary aria-disabled:active:translate-y-0"
                  data-tour="inject-encroachment"
                >
                  {inject.isPending ? (
                    <Spinner aria-hidden="true" role="presentation" />
                  ) : (
                    <Zap aria-hidden="true" />
                  )}
                  {inject.isPending
                    ? `Re-rating ${requested?.asset ?? asset.name}…`
                    : `Inject ${preset.label.toLowerCase()}`}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <form
                  className="grid gap-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setConfirming(false);
                    void run();
                  }}
                >
                  <DialogHeader>
                    <DialogTitle>
                      Inject {preset.label.toLowerCase()} at {asset.name}?
                    </DialogTitle>
                    <DialogDescription>
                      {preset.description} The site is re-rated now, its stake
                      price re-anchors and the event is stored as simulated.
                      {preset.alerts &&
                        " Its holders and community get a news alert."}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="outline">
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="submit">Inject and re-rate</Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
            <p role="status" aria-live="polite" className="text-sm">
              {inject.isPending
                ? requested &&
                  `Applying ${requested.preset} and re-rating ${requested.asset}…`
                : inject.data && (
                    <span className="sr-only">
                      {eventOutcomeText(inject.data, resultName)}
                    </span>
                  )}
            </p>
          </div>
          <div className="min-w-0">
            {failure ? (
              <Alert variant="destructive">
                <TriangleAlertIcon aria-hidden="true" />
                <AlertTitle>{failure.title}</AlertTitle>
                <AlertDescription>
                  <p>{failure.message}</p>
                </AlertDescription>
              </Alert>
            ) : inject.data ? (
              <EventResult result={inject.data} name={resultName} />
            ) : (
              <p className="text-sm text-muted-foreground">
                The result shows here: health, grade and stake price before and
                after, as stored.
              </p>
            )}
          </div>
          {inject.data && <SentAlerts ids={inject.data.alert_ids ?? []} />}
        </div>
      )}
    </Panel>
  );
}
