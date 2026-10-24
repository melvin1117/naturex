"use client";

import { ArrowUp } from "lucide-react";
import Link from "@/components/app-link";
import { usePathname } from "@/lib/nav";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { AccountCopilot } from "@/components/account-copilot";
import { Bea } from "@/components/bea/bea";
import { BeaSheetTitle, SITE_SUBTITLE } from "@/components/bea/bea-sheet-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader } from "@/components/ui/sheet";
import { useReturnFocus } from "@/lib/use-return-focus";
import { BEA_MODEL, beaState, bzzTurnId, type BeaTurn } from "@/lib/bea";
import { modelLabel } from "@/lib/trace-view";
import { SUGGESTED_QUESTIONS } from "@/lib/prototype/copilot";
import { useTour } from "@/components/proto/tour";
import { useWorld } from "@/lib/hooks";
import { usePrototype } from "@/lib/prototype/store";
import { traceAssetFromPath } from "@/lib/run-trace";

function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith("**") ? (
          <strong key={i} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * The header's Bea sheet ("Ask Bea"; was the Copilot). A signed-in account, or a sandbox
 * persona, gets her real answers (#213): world-wide, or about the site whose page is open.
 * Anonymous visitors and the guided tour keep the prototype's scripted answers.
 */
export function CopilotSheet() {
  const { ui, closeCopilot } = usePrototype();
  const tour = useTour();
  const pathname = usePathname();
  const { world: apiWorld } = useWorld();
  const real = Boolean(apiWorld?.me) && !tour.active;
  const returnFocus = useReturnFocus(ui.copilotOpen);

  return (
    <Sheet
      modal={!tour.active}
      open={ui.copilotOpen}
      onOpenChange={(open) => !open && closeCopilot()}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-md"
        data-tour="copilot-sheet"
        onCloseAutoFocus={returnFocus}
        onInteractOutside={(e) => {
          if ((e.target as HTMLElement | null)?.closest("[data-tour-card]"))
            e.preventDefault();
        }}
      >
        {/* The sheet mounts its content only while open. */}
        {real ? (
          <AccountCopilot
            pageAssetId={traceAssetFromPath(pathname)}
            onNavigate={closeCopilot}
          />
        ) : (
          <ScriptedCopilot />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The prototype's scripted Bea: a site to ask about and recorded answers. */
function ScriptedCopilot() {
  const { world, ui, closeCopilot, ask, openCopilot } = usePrototype();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const rated = world.sites.filter((s) => s.reports.length);
  const siteId =
    ui.copilotSiteId ??
    rated.find((s) => s.id === "xochimilco-wetland")?.id ??
    rated[0]?.id ??
    null;
  const site = world.sites.find((s) => s.id === siteId);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
        ? "auto"
        : "smooth",
    });
  }, [world.copilot.length, ui.copilotTyping]);

  // The scripted answers follow Bea's rules too: an answer without a source is one she can't give.
  const answers: BeaTurn[] = world.copilot
    .filter((m) => m.role !== "user")
    .map((m) => ({
      id: m.id,
      status: "done",
      mode: m.citations.length > 0 ? "model" : "refusal",
      citations: m.citations,
      answer: m.text,
    }));
  const bea = ui.copilotTyping ? "thinking" : beaState(answers);
  const bzz = bzzTurnId(answers);

  function submit(q: string) {
    if (!q.trim()) return;
    ask(q, siteId);
    setDraft("");
  }

  return (
    <>
      <SheetHeader className="border-b px-6 pt-6 pb-4">
        <BeaSheetTitle state={bea} subtitle={SITE_SUBTITLE} />
        <p className="text-xs text-muted-foreground">
          This preview uses scripted answers. In your sandbox, Bea answers live
          on {modelLabel(BEA_MODEL)}.
        </p>
        {rated.length > 0 && (
          <Select
            value={siteId ?? undefined}
            onValueChange={(v) => openCopilot(v)}
          >
            <SelectTrigger
              className="mt-2 w-full"
              aria-label="Site to ask about"
            >
              <SelectValue placeholder="Choose a site" />
            </SelectTrigger>
            <SelectContent>
              {rated.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SheetHeader>
      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5"
        aria-live="polite"
      >
        {world.copilot.length === 0 && (
          <div className="grid justify-items-center gap-2 px-2 pt-4 text-center">
            <Bea state={bea} size={96} label="" />
            <p className="font-serif text-2xl leading-tight">
              Ask Bea about {site ? site.name : "a site"}
            </p>
            <p className="max-w-[34ch] text-sm text-muted-foreground">
              Why its grade or price changed, how its worth is estimated, or how
              sure the rating is.
            </p>
          </div>
        )}
        {world.copilot.map((m) => (
          <div
            key={m.id}
            className={cn(
              "flex",
              m.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            <div
              className={cn(
                "nx-rise max-w-[88%] rounded-3xl px-4 py-3 text-sm leading-relaxed",
                m.role === "user"
                  ? "rounded-br-lg bg-primary text-primary-foreground"
                  : "rounded-bl-lg bg-card shadow-soft",
              )}
            >
              {m.id === bzz && "Bzz. "}
              <Rich text={m.text} />
              {m.citations.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {m.citations.map((c) => (
                    <Link
                      key={c.label + c.href}
                      href={c.href}
                      onClick={closeCopilot}
                      className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-accent"
                    >
                      {c.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {ui.copilotTyping && (
          <div className="flex">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Bea state="thinking" size={28} label="" />
              Bea is reading the Record…
            </p>
          </div>
        )}
      </div>
      <div className="border-t px-6 pt-3 pb-6">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => submit(q)}
              className="rounded-full border border-input bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent"
            >
              {q}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
          className="flex gap-2"
        >
          <label htmlFor="copilot-input" className="sr-only">
            Ask Bea
          </label>
          <Input
            id="copilot-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Why did it drop?"
            className="rounded-full"
            data-tour="copilot-input"
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send question"
            disabled={!draft.trim()}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </form>
      </div>
    </>
  );
}
