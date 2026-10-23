"use client";

import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "cn";

import { Spinner } from "@/components/ui/spinner";
import { toApiError } from "@/lib/api/errors";
import { useStartDemo } from "@/lib/hooks";
import { sandboxHref } from "@/lib/sandbox";
import { personaLabel, type SwitchablePersona } from "@/lib/sandbox-personas";

/** One step of NatureX's loop, who does it in the sandbox and where. A guide, not a script:
 * every step opens the real screen and the visitor goes anywhere from there. */
export type FlowStep = {
  key: string;
  title: string;
  body: string;
  persona: SwitchablePersona;
  path: string;
};

export const SANDBOX_FLOW: FlowStep[] = [
  {
    key: "list",
    title: "List land",
    body: "Draw any land on Earth. AI agents rate it live from satellite data and local news.",
    persona: "rosa",
    path: "/steward/list",
  },
  {
    key: "verify",
    title: "Check it's theirs",
    body: "Review the community's documents with the AI's checklist, then approve.",
    persona: "admin",
    path: "/admin/verifications",
  },
  {
    key: "open",
    title: "Open it to supporters",
    body: "Set the opening offer. The price comes from the rating.",
    persona: "rosa",
    path: "/steward/listings",
  },
  {
    key: "back",
    title: "Back a community",
    body: "Buy units with play money. What the offer raises goes to the community.",
    persona: "arjun",
    path: "/",
  },
  {
    key: "time",
    title: "Move time forward",
    body: "Bring a fire or a restoration. Ratings, prices and alerts react.",
    persona: "admin",
    path: "/admin",
  },
];

/** Where "Open my sandbox" lands: the marketplace, as the supporter. */
export const LOOK_AROUND: FlowStep = {
  key: "look",
  title: "Open my sandbox",
  body: "",
  persona: "arjun",
  path: "/",
};

function startError(code: string | null | undefined): string {
  if (code === "too_many_attempts")
    return "Too many sandboxes from this network this hour. Try again a little later.";
  if (code === "demo_busy")
    return "Every new sandbox for this hour is taken. Try again in a few minutes.";
  return "That didn't work. Try again.";
}

export type OpenSandbox = {
  busy: string | null;
  error: { key: string; text: string } | null;
  open: (step: FlowStep) => Promise<void>;
};

/** Open the visitor's sandbox as a step's persona and go to its screen (`POST /demo/start`:
 * a browser that has one keeps it and only switches who it acts as). */
export function useOpenSandbox(): OpenSandbox {
  const router = useRouter();
  const start = useStartDemo();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<OpenSandbox["error"]>(null);
  const open = async (step: FlowStep) => {
    if (busy) return;
    setBusy(step.key);
    setError(null);
    try {
      await start.mutateAsync(step.persona);
      router.push(sandboxHref(step.path));
    } catch (e) {
      setError({ key: step.key, text: startError(toApiError(e).code) });
      setBusy(null);
    }
  };
  return { busy, error, open };
}

const TONES = {
  dark: {
    item: "bg-machine-raised text-machine-ink hover:bg-machine-line focus-visible:ring-lime",
    number: "bg-machine-line text-lime",
    muted: "text-machine-muted",
    error: "text-clay",
  },
  light: {
    item: "bg-card text-foreground hover:bg-muted focus-visible:ring-ring",
    number: "bg-primary/10 text-primary",
    muted: "text-muted-foreground",
    error: "text-destructive",
  },
} as const;

/** NatureX's loop as numbered steps; each opens the sandbox there, as the right person. */
export function SandboxFlow({
  sandbox,
  tone = "dark",
  label = "What you can do in your sandbox",
}: {
  sandbox: OpenSandbox;
  tone?: keyof typeof TONES;
  label?: string;
}) {
  const t = TONES[tone];
  return (
    <ol aria-label={label} className="grid gap-2">
      {SANDBOX_FLOW.map((step, i) => (
        <li key={step.key}>
          <button
            type="button"
            onClick={() => void sandbox.open(step)}
            disabled={sandbox.busy !== null}
            aria-busy={sandbox.busy === step.key || undefined}
            aria-describedby={
              sandbox.error?.key === step.key
                ? `flow-err-${step.key}`
                : undefined
            }
            className={cn(
              "group grid w-full grid-cols-[2rem_1fr_auto] items-start gap-3 rounded-2xl px-3.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60",
              t.item,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "tabular mt-0.5 grid size-7 place-items-center rounded-full font-mono text-[13px]",
                t.number,
              )}
            >
              {sandbox.busy === step.key ? (
                <Spinner className="size-3.5" />
              ) : (
                i + 1
              )}
            </span>
            <span className="min-w-0">
              <b className="block font-semibold">{step.title}</b>
              <span className={cn("block text-[13.5px] leading-snug", t.muted)}>
                {step.body}
              </span>
              <span
                className={cn("mt-1 block font-mono text-[11.5px]", t.muted)}
              >
                as {personaLabel(step.persona)}
              </span>
              {sandbox.busy === step.key && (
                <span className="sr-only">Opening your sandbox…</span>
              )}
            </span>
            <ArrowRight
              aria-hidden="true"
              className={cn(
                "mt-1.5 size-4 opacity-40 transition-opacity group-hover:opacity-100",
                t.muted,
              )}
            />
          </button>
          {sandbox.error?.key === step.key && (
            <p
              id={`flow-err-${step.key}`}
              role="alert"
              className={cn("mt-1.5 px-1 text-sm", t.error)}
            >
              {sandbox.error.text}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
