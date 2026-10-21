"use client";

import { ArrowLeft, Check, RefreshCwIcon, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { ListingFlow as PrototypeListingFlow } from "@/components/proto/listing-flow";
import { useStewardCommunity } from "@/components/shell/steward-community";
import { focusIfLost } from "@/components/steward/focus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isApiAssetId } from "@/lib/asset-detail";
import type { AssetDetail, MyCommunity } from "@/lib/api/types";
import { useAsset, useWorld } from "@/lib/hooks";
import {
  boundaryPoints,
  clearUnsavedListing,
  listingHref,
  readUnsavedListing,
  stewardHomeHref,
  unsavedListingKey,
  writeUnsavedListing,
  type FieldErrors,
  type ListingDetailsForm,
} from "@/lib/listing";
import type { LatLng } from "@/lib/prototype/data";

import { BoundaryStep } from "./boundary-step";
import { DetailsStep } from "./details-step";
import { ListedStep } from "./listed-step";
import { RatingStep } from "./rating-step";
import { Loading, Page } from "./shared";

const STEPS = ["Details", "Boundary", "Rating", "Opening offer"];

/**
 * `/steward/list`: list land for the active community (T33). Signed in, the real listing
 * lifecycle (T58) and live rating progress (T27); an anonymous visitor in the scripted demo
 * gets the prototype's flow until T65 gives the demo real sessions.
 */
export function ListingScreen() {
  const { world } = useWorld();
  // Until the session answers, signed-in stewards must not glimpse the prototype.
  if (!world) return <Loading>Loading…</Loading>;
  if (!world.me) return <PrototypeListingFlow />;
  return (
    <Suspense fallback={<Loading>Loading…</Loading>}>
      <ListingFromUrl />
    </Suspense>
  );
}

function ListingFromUrl() {
  const router = useRouter();
  const { active } = useStewardCommunity();
  const raw = useSearchParams().get("asset");
  const assetId = raw && isApiAssetId(raw) ? raw : null;
  // A draft just created here, until the URL catches up (`router.replace`) and while it shows it.
  const [created, setCreated] = useState<string | null>(null);
  const [previous, setPrevious] = useState(assetId);
  if (assetId !== previous) {
    setPrevious(assetId);
    if (created && assetId !== created) setCreated(null);
  }
  if (!active) {
    return (
      <Page>
        <Alert>
          <AlertTitle className="line-clamp-none">
            Start a community first
          </AlertTitle>
          <AlertDescription>
            <p>Land is listed by a community. Create one, then come back.</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/steward">Go to the Steward home</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </Page>
    );
  }
  if (raw && !assetId) return <NotFound community={active} />;
  const shown = assetId ?? created;
  // A new key per listing: switching community or listing starts from a clean form, but the
  // draft created here keeps its state when its ID reaches the URL.
  return (
    <ListingLoader
      key={`${active.id}:${shown ?? "new"}`}
      community={active}
      assetId={shown}
      focusOnMount={shown !== null && shown === created}
      onCreated={(asset) => {
        setCreated(asset.id);
        router.replace(listingHref(active.id, asset.id), { scroll: false });
      }}
    />
  );
}

function ListingLoader({
  community,
  assetId,
  focusOnMount,
  onCreated,
}: {
  community: MyCommunity;
  assetId: string | null;
  /** The draft just saved here remounts this loader: its next step takes focus. */
  focusOnMount: boolean;
  onCreated: (asset: AssetDetail) => void;
}) {
  const { communities } = useStewardCommunity();
  const meId = useWorld().world?.me?.id ?? "";
  const query = useAsset(assetId ?? undefined);
  const asset = query.data;

  if (assetId && !asset) {
    if (query.error?.status === 404) return <NotFound community={community} />;
    if (query.error)
      return (
        <Page>
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              We couldn&apos;t load this listing
            </AlertTitle>
            <AlertDescription>
              <p>{query.error.message}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void query.refetch()}
              >
                <RefreshCwIcon aria-hidden="true" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </Page>
      );
    return <Loading>Loading your listing…</Loading>;
  }

  if (asset && asset.community_id !== community.id) {
    const owner = communities.find((c) => c.id === asset.community_id);
    return (
      <Page>
        <Alert>
          <AlertTitle className="line-clamp-none">
            This listing belongs to another community
          </AlertTitle>
          <AlertDescription>
            {owner ? (
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link href={listingHref(owner.id, asset.id)}>
                  Open it in {owner.name}
                </Link>
              </Button>
            ) : (
              <p>Only its own community can manage it.</p>
            )}
          </AlertDescription>
        </Alert>
      </Page>
    );
  }

  return (
    <ListingWizard
      community={community}
      meId={meId}
      asset={asset ?? null}
      focusOnMount={focusOnMount}
      onCreated={onCreated}
    />
  );
}

function NotFound({ community }: { community: MyCommunity }) {
  return (
    <Page>
      <Alert>
        <AlertTitle className="line-clamp-none">
          We couldn&apos;t find that listing
        </AlertTitle>
        <AlertDescription>
          <p>
            It may have been removed, or it belongs to a community you&apos;re
            not in.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href={listingHref(community.id)}>Start a new listing</Link>
          </Button>
        </AlertDescription>
      </Alert>
    </Page>
  );
}

function initialForm(
  asset: AssetDetail | null,
  community: MyCommunity,
): ListingDetailsForm {
  return {
    name: asset?.name ?? "",
    country: asset ? (asset.country ?? "") : (community.country ?? ""),
    description: asset?.description ?? "",
    attestation: false,
  };
}

function ListingWizard({
  community,
  meId,
  asset,
  focusOnMount,
  onCreated,
}: {
  community: MyCommunity;
  meId: string;
  asset: AssetDetail | null;
  focusOnMount: boolean;
  onCreated: (asset: AssetDetail) => void;
}) {
  const storageKey = unsavedListingKey(meId, community.id);
  // A new listing picks up what was entered in this tab before (a sign-in, a reload).
  const [restored] = useState(() =>
    asset ? null : readUnsavedListing(storageKey),
  );
  const [form, setForm] = useState<ListingDetailsForm>(() =>
    restored
      ? { ...restored.form, attestation: false }
      : initialForm(asset, community),
  );
  const [points, setPoints] = useState<LatLng[]>(() =>
    asset ? boundaryPoints(asset.geojson) : (restored?.points ?? []),
  );
  const unsaved =
    !asset &&
    (points.length > 0 ||
      form.name.trim() !== "" ||
      form.description.trim() !== "");

  useEffect(() => {
    if (asset) return;
    writeUnsavedListing(storageKey, {
      form: {
        name: form.name,
        country: form.country,
        description: form.description,
      },
      points,
    });
  }, [asset, storageKey, form, points]);

  // Leaving the page (reload, closing the tab) while the listing exists only in this browser.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // A resumed draft opens on its review; a new listing on its details.
  const [draftStep, setDraftStep] = useState(asset ? 2 : 0);
  const status = asset?.status ?? "draft";
  const step =
    status === "draft"
      ? draftStep
      : status === "listed" || status === "suspended"
        ? 3
        : 2;

  // A new step replaces the one that held focus: move it to the step, not back to <body>.
  const stepRef = useRef<HTMLElement>(null);
  const shownStep = useRef<number | null>(focusOnMount ? null : step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    focusIfLost(stepRef.current);
  }, [step]);

  return (
    <Page>
      <Link
        href={stewardHomeHref(community.id)}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Community home
      </Link>
      <h1 className="mt-3 font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        {asset ? asset.name : "List your land"}
      </h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Draw the land {community.name} protects. NatureX rates it from satellite
        data and local news, then you decide whether to open it to supporters.
        The land always stays yours.
      </p>
      {restored && (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          We kept what you entered earlier in this tab. Confirm the attestation
          again before saving.
        </p>
      )}

      <ol className="mt-8 flex flex-wrap gap-2" aria-label="Listing steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium",
                i < step
                  ? "bg-primary text-primary-foreground"
                  : i === step
                    ? "bg-card text-foreground shadow-soft"
                    : "text-muted-foreground",
              )}
              aria-current={i === step ? "step" : undefined}
            >
              <span
                className={cn(
                  "tabular grid size-5 place-items-center rounded-full text-[11px]",
                  i < step
                    ? "bg-lime text-foreground"
                    : i === step
                      ? "bg-primary text-primary-foreground"
                      : "bg-foreground/10",
                )}
              >
                {i < step ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : (
                  i + 1
                )}
              </span>
              {label}
              {i < step && <span className="sr-only">, done</span>}
            </span>
          </li>
        ))}
      </ol>

      <section
        ref={stepRef}
        tabIndex={-1}
        aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
        className="mt-6 rounded-[1.75rem] outline-none"
      >
        {step === 0 && (
          <DetailsStep
            community={community}
            asset={asset}
            form={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            errors={fieldErrors}
            setErrors={setFieldErrors}
            onNext={() => setDraftStep(1)}
          />
        )}
        {step === 1 && (
          <BoundaryStep
            community={community}
            asset={asset}
            form={form}
            points={points}
            setPoints={setPoints}
            onBack={() => setDraftStep(0)}
            onDetailsRejected={(errors) => {
              setFieldErrors(errors);
              setDraftStep(0);
            }}
            onSaved={(saved) => {
              if (!asset) {
                clearUnsavedListing(storageKey);
                onCreated(saved);
              }
              setDraftStep(2);
            }}
          />
        )}
        {step === 2 && asset && (
          <RatingStep
            community={community}
            asset={asset}
            onEdit={(n) => setDraftStep(n)}
            onRevised={(revised) => {
              setPoints(boundaryPoints(revised.geojson));
              setDraftStep(1);
            }}
          />
        )}
        {step === 3 && asset && (
          <ListedStep community={community} asset={asset} />
        )}
      </section>
    </Page>
  );
}
