"use client";

import { BellRing } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { cn } from "cn";

import { usePrototype } from "@/lib/prototype/store";
import { PERSONAS } from "@/lib/prototype/world";

/** New alerts arrive as a phone-style notification for the persona they belong to. */
export function AlertToaster() {
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
          <div
            className={cn(
              "flex w-[360px] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-[1.4rem] bg-card/95 p-3.5 shadow-lift ring-1 ring-border backdrop-blur",
            )}
          >
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-xl text-white",
                alert.severity === "critical" ? "bg-clay" : "bg-grade-aa",
              )}
              aria-hidden="true"
            >
              <BellRing className="size-4" />
            </span>
            <div className="min-w-0 text-sm">
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  NatureX · {PERSONAS[alert.persona].name}&apos;s phone
                </span>
                <span>now</span>
              </div>
              <div className="mt-0.5 font-semibold">{alert.title}</div>
              <div className="mt-0.5 text-muted-foreground">
                {alert.message}
              </div>
            </div>
          </div>
        ),
        { duration: 7000 },
      );
    }
  }, [world.alerts, hydrated]);

  return null;
}
