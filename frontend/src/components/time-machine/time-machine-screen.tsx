"use client";

import { ArrowRight, LockKeyhole } from "lucide-react";
import Link from "@/components/app-link";
import { useCallback, useMemo, useState } from "react";

import {
  PanelSkeleton,
  TimeMachineBodySkeleton,
} from "@/components/page-skeletons";
import { ControlRoom } from "@/components/proto/control-room";
import { LoadError } from "@/components/proto/load-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAssets, useWorld } from "@/lib/hooks";
import { SANDBOX_ONLY, unavailableReason } from "@/lib/time-machine";
import { useTimeMachine } from "@/lib/time-machine-hooks";

import { EventSection } from "./event-section";
import { QuarterSection } from "./quarter-section";
import { ResetSection } from "./reset-section";
import { TimeMachineHeading } from "./time-machine-heading";

/**
 * `/admin`: the Time Machine as a page, for anyone in the sandbox (the header's sheet is the
 * usual way in); the scripted prototype control room without an account.
 */
export function AdminScreen() {
  const { world } = useWorld();
  return world?.me ? <TimeMachinePanel /> : <ControlRoom />;
}

/**
 * The Time Machine: the sandbox's next quarter, injected events and reset. Anyone in a sandbox
 * may use it (the backend's `SIMULATE`). `variant="sheet"` drops the page's frame and heading
 * for the header's Time Machine sheet.
 */
export function TimeMachinePanel({
  variant = "page",
}: {
  variant?: "page" | "sheet";
} = {}) {
  const state = useTimeMachine();
  const assets = useAssets();
  // A reset remounts the sections, so no result from before it stays on screen.
  const [generation, setGeneration] = useState(0);
  const [quarterPending, setQuarterPending] = useState(false);
  const [eventPending, setEventPending] = useState(false);
  const listed = useMemo(
    () => (assets.data ?? []).filter((a) => a.status === "listed"),
    [assets.data],
  );
  const names = useMemo(
    () => new Map((assets.data ?? []).map((a) => [a.id, a.name])),
    [assets.data],
  );
  const unavailable = state.data
    ? unavailableReason(state.data)
    : state.error?.code === "time_machine_sandbox_only"
      ? SANDBOX_ONLY.message
      : null;
  const { refetch: refetchState } = state;
  const { refetch: refetchAssets } = assets;
  const refresh = useCallback(() => {
    void refetchState();
    void refetchAssets();
  }, [refetchState, refetchAssets]);

  return (
    <div
      className={
        variant === "sheet"
          ? undefined
          : "mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6"
      }
    >
      {variant === "page" && <TimeMachineHeading />}

      {unavailable ? (
        <Alert className="mt-8 max-w-2xl">
          <LockKeyhole aria-hidden="true" />
          <AlertTitle>{SANDBOX_ONLY.title}</AlertTitle>
          <AlertDescription>
            <p>{unavailable}</p>
            {/* Not a dead end: in the live world, the admin's work is the review queue. */}
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/admin/verifications">
                Go to the verification queue
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : state.data ? (
        <>
          <div key={generation}>
            <QuarterSection
              state={state.data}
              listed={listed.length}
              names={names}
              onRefresh={refresh}
              onPendingChange={setQuarterPending}
            />
            <div className="mt-8">
              {assets.data ? (
                <EventSection
                  presets={state.data.presets}
                  assets={listed}
                  onRefresh={refresh}
                  onPendingChange={setEventPending}
                />
              ) : assets.error ? (
                <LoadError
                  title="We couldn't load the sites"
                  error={assets.error}
                  retry={assets.refetch}
                />
              ) : (
                <PanelSkeleton label="Loading sites…" />
              )}
            </div>
          </div>
          <ResetSection
            className="mt-8"
            busy={quarterPending || eventPending}
            onReset={() => setGeneration((g) => g + 1)}
          />
        </>
      ) : state.error ? (
        <div className="mt-8 max-w-2xl">
          <LoadError
            title="We couldn't load the Time Machine"
            error={state.error}
            retry={state.refetch}
          />
        </div>
      ) : (
        <TimeMachineBodySkeleton />
      )}
    </div>
  );
}
