"use client";

import { LockKeyhole } from "lucide-react";
import { useMemo, useState } from "react";

import { ControlRoom } from "@/components/proto/control-room";
import { LoadError } from "@/components/proto/load-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { useAssets, useWorld } from "@/lib/hooks";
import { SANDBOX_ONLY, unavailableReason } from "@/lib/time-machine";
import { useTimeMachine } from "@/lib/time-machine-hooks";

import { EventSection } from "./event-section";
import { QuarterSection } from "./quarter-section";
import { ResetSection } from "./reset-section";

/**
 * `/admin`: the real Time Machine for a signed-in admin (the layout lets only admins in); the
 * scripted prototype control room otherwise, like the other screens.
 */
export function AdminScreen() {
  const { world } = useWorld();
  return world?.me ? <TimeMachinePanel /> : <ControlRoom />;
}

function Loading({ label }: { label: string }) {
  return (
    <p
      role="status"
      className="mt-8 flex items-center gap-2 py-10 text-sm text-muted-foreground"
    >
      <Spinner aria-hidden="true" role="presentation" />
      {label}
    </p>
  );
}

export function TimeMachinePanel() {
  const { world } = useWorld();
  const me = world?.me;
  const state = useTimeMachine();
  const assets = useAssets();
  // A reset remounts the sections, so no result from before it stays on screen.
  const [generation, setGeneration] = useState(0);
  const listed = useMemo(
    () => (assets.data ?? []).filter((a) => a.status === "listed"),
    [assets.data],
  );
  const names = useMemo(
    () => new Map((assets.data ?? []).map((a) => [a.id, a.name])),
    [assets.data],
  );
  const unavailable = state.data
    ? unavailableReason(state.data, me)
    : state.error?.code === "time_machine_sandbox_only"
      ? SANDBOX_ONLY.message
      : null;
  const refresh = () => {
    void state.refetch();
    void assets.refetch();
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6">
      <p className="text-sm text-muted-foreground">
        Control room · play money only
      </p>
      <h1 className="mt-1 font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Time Machine
      </h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Move this sandbox forward a quarter or inject an event, and watch
        ratings, prices and alerts respond. Every change is a real re-rate,
        stored and labelled simulated.
      </p>

      {unavailable ? (
        <Alert className="mt-8 max-w-2xl">
          <LockKeyhole aria-hidden="true" />
          <AlertTitle>{SANDBOX_ONLY.title}</AlertTitle>
          <AlertDescription>
            <p>{unavailable}</p>
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
            />
            <div className="mt-8">
              {assets.data ? (
                <EventSection
                  presets={state.data.presets}
                  assets={listed}
                  onRefresh={refresh}
                />
              ) : assets.error ? (
                <LoadError
                  title="We couldn't load the sites"
                  error={assets.error}
                  retry={assets.refetch}
                />
              ) : (
                <Loading label="Loading sites…" />
              )}
            </div>
          </div>
          <ResetSection
            className="mt-8"
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
        <Loading label="Loading the Time Machine…" />
      )}
    </div>
  );
}
