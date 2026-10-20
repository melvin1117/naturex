"use client";

import { useId } from "react";

import { AlertCard } from "@/components/proto/alert-toaster";
import { LoadError } from "@/components/proto/load-error";
import { Spinner } from "@/components/ui/spinner";
import { useSentAlerts } from "@/lib/time-machine-hooks";

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function reach(n: number) {
  return n === 1 ? "Sent to 1 account" : `Sent to ${n} accounts`;
}

/**
 * The alerts a quarter or event sent, on a phone (T43; demo-plan chapter 7): the stored
 * alerts as their recipients got them, with how many accounts each reached.
 */
export function SentAlerts({ ids }: { ids: readonly string[] }) {
  const sent = useSentAlerts(ids);
  const titleId = useId();

  if (ids.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No alerts were sent: nothing crossed a threshold (health moved 5 points,
        the grade changed, or an event of severity 4 or more).
      </p>
    );
  }

  return (
    <figure aria-labelledby={titleId} className="min-w-0 space-y-3">
      <figcaption id={titleId} className="text-sm font-medium">
        What holders and the community received
      </figcaption>
      <div className="mx-auto w-full max-w-[20rem] rounded-[2.5rem] bg-machine p-2.5 shadow-lift">
        <div className="min-h-64 rounded-[2rem] bg-muted px-3 pt-3 pb-6">
          <div
            className="mx-auto mb-4 h-1.5 w-16 rounded-full bg-machine/30"
            aria-hidden="true"
          />
          {sent.data ? (
            <ul className="space-y-2.5" aria-label="Alerts sent">
              {sent.data.map((alert) => (
                <li key={alert.id}>
                  <AlertCard
                    from={`NatureX · ${alert.asset_name}`}
                    title={alert.title}
                    message={alert.message}
                    urgent={alert.severity >= 4}
                    time={clock(alert.created_at)}
                    className="w-full max-w-none shadow-soft"
                  />
                  <p className="mt-1 px-2 text-xs text-muted-foreground">
                    {reach(alert.recipients)}
                  </p>
                </li>
              ))}
            </ul>
          ) : sent.error ? (
            <LoadError
              title="We couldn't load the alerts"
              error={sent.error}
              retry={sent.refetch}
            />
          ) : (
            <p
              role="status"
              className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
            >
              <Spinner aria-hidden="true" role="presentation" />
              Loading alerts…
            </p>
          )}
        </div>
      </div>
    </figure>
  );
}
