"use client";

import { useEffect, useState } from "react";

import { LandCoverLegend } from "@/components/land-cover-legend";
import { LandCoverMap } from "@/components/land-cover-map";
import { SiteThumbnail } from "@/components/site-thumbnail";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api";
import {
  DEMO_SITES,
  demoSiteMediaUrl,
  type SiteImages,
} from "@/lib/demo-site-images";

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; images: SiteImages };

async function fetchSiteImages(siteKey: string): Promise<SiteImages | null> {
  try {
    const { data } = await api.GET("/media/demo-sites/{site_key}/images.json", {
      params: { path: { site_key: siteKey } },
    });
    // openapi-fetch widens the generated `bounds` tuples to number[][]; the schema is the same.
    return (data as SiteImages | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Dev-only preview of the precomputed overlay and thumbnail for each demo site (T35). */
export function DemoSiteImages() {
  const [siteKey, setSiteKey] = useState<string>(DEMO_SITES[0].key);
  const [state, setState] = useState<State>({ status: "loading" });
  const site =
    DEMO_SITES.find((entry) => entry.key === siteKey) ?? DEMO_SITES[0];

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void fetchSiteImages(siteKey).then((images) => {
      if (active)
        setState(images ? { status: "ready", images } : { status: "error" });
    });
    return () => {
      active = false;
    };
  }, [siteKey]);

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Demo site" className="flex flex-wrap gap-2">
        {DEMO_SITES.map((entry) => (
          <Button
            key={entry.key}
            size="sm"
            variant={entry.key === siteKey ? "default" : "outline"}
            aria-pressed={entry.key === siteKey}
            onClick={() => setSiteKey(entry.key)}
          >
            {entry.name}
          </Button>
        ))}
      </div>

      {state.status === "error" && (
        <Alert variant="destructive">
          <AlertDescription>
            Couldn&apos;t load the images for {site.name}. Is the backend
            running?
          </AlertDescription>
        </Alert>
      )}
      {state.status === "loading" && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Loading {site.name}…
        </p>
      )}
      {state.status === "ready" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Land-cover overlay</CardTitle>
              <CardDescription>
                Dynamic World mode, {state.images.overlay.date_window.start} to{" "}
                {state.images.overlay.date_window.end}.{" "}
                {state.images.scenario_note}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <LandCoverMap
                overlayUrl={demoSiteMediaUrl(siteKey, "overlay.png")}
                bounds={state.images.overlay.bounds}
                label={site.name}
              />
              <LandCoverLegend entries={state.images.overlay.legend} />
              <div className="space-y-1 text-xs text-muted-foreground">
                {state.images.overlay.attributions.map((text) => (
                  <p key={text}>{text}</p>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Marketplace thumbnail</CardTitle>
              <CardDescription>
                {state.images.thumbnail.width}×{state.images.thumbnail.height}{" "}
                WebP with the polygon outline.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SiteThumbnail
                src={demoSiteMediaUrl(siteKey, "thumbnail.webp")}
                alt={`Satellite view of ${site.name} with its boundary`}
                width={state.images.thumbnail.width}
                height={state.images.thumbnail.height}
                dateWindow={state.images.thumbnail.date_window}
                attributions={state.images.thumbnail.attributions}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
