"use client";

import { ChevronDown, Cpu, Lock, Wrench } from "lucide-react";
import Link from "@/components/app-link";
import { usePathname } from "@/lib/nav";
import { useState } from "react";
import { cn } from "cn";

import {
  AssetRunsTrace,
  RunTraceView,
  WorldModelCalls,
} from "@/components/agent-trace";
import { SampleTag } from "@/components/proto/bits";
import { EvalResults } from "@/components/trace/eval-results";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useReturnFocus } from "@/lib/use-return-focus";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MODELS } from "@/lib/prototype/data";
import { date } from "@/lib/prototype/format";
import { useTour } from "@/components/proto/tour";
import { useWorld } from "@/lib/hooks";
import { usePrototype } from "@/lib/prototype/store";
import { runTotals, type TraceStep } from "@/lib/prototype/trace";
import { isApiAssetId } from "@/lib/asset-detail";
import { traceMode } from "@/lib/run-trace";

const TRIGGER: Record<string, string> = {
  listing: "New listing",
  time_machine: "Time Machine",
  event: "Event re-rate",
  seed: "Auditor review",
};

/**
 * The Agent Trace drawer. On a real site (`/asset/<uuid>`) it reads that site's rating runs from
 * `GET /runs/{id}/trace`; signed in elsewhere, the world's latest model calls; anonymous
 * visitors away from a real site and the guided tour keep the prototype's recorded runs.
 */
export function TraceSheet() {
  const { world, ui, closeTrace } = usePrototype();
  const tour = useTour();
  const pathname = usePathname();
  const { world: apiWorld } = useWorld();
  const mode = traceMode({
    pathname,
    signedIn: Boolean(apiWorld?.me),
    tourActive: tour.active,
  });
  // A real run asked for by id (a UUID, unlike the prototype's run ids), e.g. the listing flow's
  // just-finished rating: shown on any page, not only on its site's.
  const realRunId =
    mode.kind === "world" && ui.traceRunId && isApiAssetId(ui.traceRunId)
      ? ui.traceRunId
      : null;
  const runs = [...world.runs].reverse();
  const [picked, setPicked] = useState<string | null>(null);
  const runId = picked ?? ui.traceRunId ?? runs[0]?.id;
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  const totals = run ? runTotals(run) : null;

  const returnFocus = useReturnFocus(ui.traceOpen);

  return (
    <Sheet
      modal={!tour.active}
      open={ui.traceOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeTrace();
          setPicked(null);
        }
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 border-machine-line bg-machine p-0 text-machine-ink sm:max-w-xl"
        data-tour="trace-sheet"
        onCloseAutoFocus={returnFocus}
        onInteractOutside={(e) => {
          if ((e.target as HTMLElement | null)?.closest("[data-tour-card]"))
            e.preventDefault();
        }}
      >
        <SheetHeader className="border-b border-machine-line px-6 pt-6 pb-4">
          <SheetTitle className="font-serif text-3xl font-normal text-machine-ink">
            Agent Trace
          </SheetTitle>
          <SheetDescription className="text-machine-muted">
            Every step of a rating run: which model or tool ran, tokens, time
            and output. All model calls go through Nebius Token Factory.
          </SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="trace" className="min-h-0 flex-1 gap-0">
          <div className="px-6 pt-4">
            <TabsList className="bg-machine-raised">
              <TabsTrigger
                value="trace"
                className="text-machine-muted data-[state=active]:bg-machine-line data-[state=active]:text-machine-ink"
              >
                {mode.kind === "world" && !realRunId ? "Model calls" : "Runs"}
              </TabsTrigger>
              <TabsTrigger
                value="routing"
                className="text-machine-muted data-[state=active]:bg-machine-line data-[state=active]:text-machine-ink"
              >
                Model routing
              </TabsTrigger>
              <TabsTrigger
                value="evals"
                className="text-machine-muted data-[state=active]:bg-machine-line data-[state=active]:text-machine-ink"
              >
                Evals
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            value="trace"
            className="machine-scroll min-h-0 overflow-y-auto px-6 pt-4 pb-8"
          >
            {/* The sheet mounts this only while open (and through its close animation). */}
            {mode.kind === "asset" ? (
              <AssetRunsTrace
                key={`${mode.assetId}:${ui.traceRunId ?? ""}`}
                assetId={mode.assetId}
                initialRunId={ui.traceRunId}
              />
            ) : realRunId ? (
              <RunTraceView key={realRunId} runId={realRunId} />
            ) : mode.kind === "world" ? (
              <WorldModelCalls />
            ) : !run ? (
              <p className="text-sm text-machine-muted">No rating runs yet.</p>
            ) : (
              <>
                <Select value={run.id} onValueChange={setPicked}>
                  <SelectTrigger className="w-full border-machine-line bg-machine-raised text-machine-ink">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {runs.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.siteName} · report v{r.reportVersion} ·{" "}
                        {TRIGGER[r.trigger]} · {date(r.startedAt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {totals && (
                  <dl className="mt-4 grid grid-cols-4 gap-2">
                    {[
                      ["Model calls", String(totals.llmCalls)],
                      ["Tokens", totals.tokens.toLocaleString("en-US")],
                      ["Time", `${(totals.latencyMs / 1000).toFixed(1)} s`],
                      ["Cost", `$${totals.costUsd.toFixed(4)}`],
                    ].map(([k, v]) => (
                      <div
                        key={k}
                        className="rounded-2xl bg-machine-raised px-3 py-2.5"
                      >
                        <dt className="text-[11px] text-machine-muted">{k}</dt>
                        <dd className="tabular mt-0.5 text-lg font-light">
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                <p className="mt-3 flex items-center gap-2 text-xs text-machine-muted">
                  <SampleTag className="text-machine-muted">Recorded</SampleTag>
                  Prototype replay: token counts and timings are illustrative
                  until the trace API (T28) is wired in.
                </p>
                <ol className="mt-4 space-y-2">
                  {run.steps.map((step) => (
                    <StepRow key={step.id} step={step} />
                  ))}
                </ol>
              </>
            )}
          </TabsContent>
          <TabsContent
            value="routing"
            className="machine-scroll min-h-0 overflow-y-auto px-6 pt-4 pb-8"
          >
            <p className="text-sm text-machine-muted">
              Routing from ADR-0003. Nemotron does all reasoning, text and
              vision; only the Copilot&apos;s embeddings use a non-NVIDIA model,
              because Token Factory serves no NVIDIA embedding model.
            </p>
            <ul className="mt-4 space-y-2">
              {[
                [
                  "Orchestrator and News Scout",
                  MODELS.orchestrator,
                  "Tool calling, sorting the news; thinks once to plan",
                ],
                [
                  "Article reader and Copilot",
                  MODELS.fast,
                  "Reads articles, chats",
                ],
                ["Auditor", MODELS.auditor, "Deep reasoning on, capped"],
                [
                  "Vision (satellite, photos, documents)",
                  MODELS.vision,
                  "Describes images; code checks them",
                ],
              ].map(([role, model, note]) => {
                const m = model as (typeof MODELS)[keyof typeof MODELS];
                return (
                  <li
                    key={role as string}
                    className="rounded-2xl bg-machine-raised px-4 py-3"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium">
                        {role as string}
                      </span>
                      <span className="tabular text-xs text-machine-muted">
                        ${m.price[0]} / ${m.price[1]} per 1M tokens
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-lime">{m.name}</div>
                    <div className="font-mono text-[11px] text-machine-muted">
                      {m.id}
                    </div>
                    <div className="mt-1 text-xs text-machine-muted">
                      {note as string}
                    </div>
                  </li>
                );
              })}
            </ul>
          </TabsContent>
          <TabsContent
            value="evals"
            className="machine-scroll min-h-0 overflow-y-auto px-6 pt-4 pb-8"
          >
            <EvalResults />
            <Link
              href="/ai"
              onClick={() => closeTrace()}
              className="mt-4 inline-block text-sm font-medium text-lime underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none"
            >
              Every model at work, with live costs
            </Link>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function StepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false);
  const Icon = step.kind === "llm" ? Cpu : step.kind === "seal" ? Lock : Wrench;
  return (
    <li className="rounded-2xl bg-machine-raised">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <span
          className={cn(
            "mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl",
            step.kind === "llm"
              ? "bg-lime text-machine"
              : "bg-machine-line text-machine-ink",
          )}
          aria-hidden="true"
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{step.label}</span>
          <span className="mt-0.5 block text-xs text-machine-muted">
            {step.agent}
            {step.model && ` · ${step.model.name}`}
            {step.reasoning !== undefined &&
              ` · reasoning ${step.reasoning ? "on" : "off"}`}
          </span>
          <span className="tabular mt-1 flex flex-wrap gap-x-3 text-[11px] text-machine-muted">
            <span>{(step.latencyMs / 1000).toFixed(2)} s</span>
            {step.tokensIn !== undefined && (
              <span>
                {step.tokensIn.toLocaleString("en-US")} in ·{" "}
                {step.tokensOut?.toLocaleString("en-US")} out
              </span>
            )}
            {step.costUsd !== undefined && (
              <span>${step.costUsd.toFixed(5)}</span>
            )}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "mt-1 size-4 shrink-0 text-machine-muted transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="px-4 pb-4">
          <p className="text-xs text-machine-muted">{step.detail}</p>
          {step.model && (
            <p className="mt-1 font-mono text-[11px] text-machine-muted">
              {step.model.id}
            </p>
          )}
          <pre className="machine-scroll mt-2 max-h-64 overflow-auto rounded-xl bg-machine p-3 font-mono text-[11px] leading-relaxed text-machine-ink">
            {JSON.stringify(step.output, null, 2)}
          </pre>
        </div>
      )}
    </li>
  );
}
