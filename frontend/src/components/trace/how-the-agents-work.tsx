"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { EvalResults } from "@/components/trace/eval-results";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MODELS } from "@/lib/site-data";

/** Which model does what (ADR-0003), with what each costs on Nebius Token Factory. */
function ModelRouting() {
  const roles = [
    [
      "Orchestrator and News Scout",
      MODELS.orchestrator,
      "Tool calling, sorting the news; thinks once to plan",
    ],
    ["Article reader and Bea", MODELS.fast, "Reads articles, chats"],
    ["Auditor", MODELS.auditor, "Deep reasoning on, capped"],
    [
      "Vision (satellite, photos, documents)",
      MODELS.vision,
      "Describes images; code checks them",
    ],
  ] as const;
  return (
    <>
      <p className="text-sm text-machine-muted">
        Nemotron does all reasoning, text and vision; only Bea&apos;s embeddings
        use a non-NVIDIA model, because Token Factory serves no NVIDIA embedding
        model.
      </p>
      <ul className="mt-4 space-y-2">
        {roles.map(([role, model, note]) => (
          <li key={role} className="rounded-2xl bg-machine-raised px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{role}</span>
              <span className="tabular text-xs text-machine-muted">
                ${model.price[0]} / ${model.price[1]} per 1M tokens
              </span>
            </div>
            <div className="mt-1 text-sm text-lime">{model.name}</div>
            <div className="font-mono text-[11px] text-machine-muted">
              {model.id}
            </div>
            <div className="mt-1 text-xs text-machine-muted">{note}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible className="border-t border-machine-line py-4">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-lg text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-lime">
        {title}
        <ChevronDown
          aria-hidden="true"
          className="size-4 text-machine-muted transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Under a rating's trace: which model does what, and how the agents are tested. Folded, so the
 * trace leads; a judge opens them to see how the models are used.
 */
export function HowTheAgentsWork() {
  return (
    <div className="mt-10">
      <Section title="Which model does what">
        <ModelRouting />
      </Section>
      <Section title="How the agents are tested">
        <EvalResults />
      </Section>
    </div>
  );
}
