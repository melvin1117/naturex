"use client";

import { BellRing } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { cn } from "cn";

import { useLiveEvent, useWorld } from "@/lib/hooks";
import { usePrototype } from "@/lib/prototype/store";
import { PERSONAS } from "@/lib/prototype/world";

/** How old (vs. page load) a replayed alert may be and still toast; allows some clock skew. */
const REPLAY_GRACE_MS = 30_000;

/**
 * New alerts arrive as a phone-style notification. Signed in, they're the account's real
 * `alert` events (T75: only the asset's holders and community get them); the anonymous
 * scripted demo shows the prototype persona's alerts.
 */
export function AlertToaster() {
  const { world } = useWorld();
  const signedIn = world?.me != null;
  const mountedAt = useRef<number | null>(null);
  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);
  useLiveEvent(
    "alert",
    ({ payload, ts }) => {
      // A new stream replays the world's retained events (24 h) on every page load; only
      // alerts raised around or after this page opened are news worth a toast.
      const since = (mountedAt.current ?? Date.now()) - REPLAY_GRACE_MS;
      if (Date.parse(ts) < since) return;
      toast.custom(
        () => (
          <AlertCard
            from="NatureX"
            title={payload.title}
            message={payload.message}
            urgent={payload.severity >= 4}
          />
        ),
        { duration: 7000 },
      );
    },
    { enabled: signedIn },
  );
  return signedIn ? null : <PrototypeAlertToaster />;
}

function PrototypeAlertToaster() {
  const { world, hydrated } = usePrototype();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!seen.current) {
      seen.current = new Set(world.alerts.map((a) => a.id));
      return;
    }
    for (const alert of world.alerts) {
      if (seen.current.has(alert.id)) continue;
      seen.current.add(alert.id);
      toast.custom(
        () => (
          <AlertCard
            from={`NatureX · ${PERSONAS[alert.persona].name}'s phone`}
            title={alert.title}
            message={alert.message}
            urgent={alert.severity === "critical"}
          />
        ),
        { duration: 7000 },
      );
    }
  }, [world.alerts, hydrated]);

  return null;
}

/** A phone-style notification: the live toast, and the Time Machine's phone preview (T43). */
export function AlertCard({
  from,
  title,
  message,
  urgent,
  time = "now",
  className,
}: {
  from: string;
  title: string;
  message: string;
  urgent: boolean;
  time?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-[360px] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-[1.4rem] bg-card/95 p-3.5 shadow-lift ring-1 ring-border backdrop-blur",
        className,
      )}
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-xl text-white",
          urgent ? "bg-clay" : "bg-grade-aa",
        )}
        aria-hidden="true"
      >
        <BellRing className="size-4" />
      </span>
      <div className="min-w-0 text-sm">
        <div className="flex items-start justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="min-w-0">{from}</span>
          <span className="shrink-0 whitespace-nowrap">{time}</span>
        </div>
        <div className="mt-0.5 font-semibold">{title}</div>
        <div className="mt-0.5 text-muted-foreground">{message}</div>
      </div>
    </div>
  );
}
