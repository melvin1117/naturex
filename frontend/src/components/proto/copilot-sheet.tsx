"use client";

import Link from "@/components/app-link";
import { usePathname } from "@/lib/nav";
import { useEffect, useRef, useState } from "react";

import { AccountCopilot } from "@/components/account-copilot";
import {
  BeaAnswer,
  BeaComposer,
  BeaEmpty,
  BeaQuestion,
  BeaSuggestion,
  SOURCE_CHIP,
} from "@/components/bea/chat-parts";
import { BeaSheetTitle, SITE_SUBTITLE } from "@/components/bea/bea-sheet-title";
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
  // A real site's page isn't in the scripted world: start on the hero site instead.
  const siteId =
    rated.find((s) => s.id === ui.copilotSiteId)?.id ??
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

  const suggestions = SUGGESTED_QUESTIONS.map((q) => (
    <BeaSuggestion key={q} onClick={() => submit(q)}>
      {q}
    </BeaSuggestion>
  ));

  return (
    <>
      <SheetHeader className="gap-3.5 border-b bg-card px-5 pt-5 pb-4">
        <BeaSheetTitle state={bea} subtitle={SITE_SUBTITLE} />
        {rated.length > 0 && (
          <Select
            value={siteId ?? undefined}
            onValueChange={(v) => openCopilot(v)}
          >
            <SelectTrigger
              className="h-9 w-full rounded-full bg-background text-[13px]"
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
        <p className="text-xs text-muted-foreground">
          A preview with scripted answers. In your own sandbox, Bea answers live
          on NVIDIA {modelLabel(BEA_MODEL)}.
        </p>
      </SheetHeader>
      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5"
        aria-live="polite"
      >
        {world.copilot.length === 0 && (
          <BeaEmpty
            state={bea}
            title={`Ask Bea about ${site ? site.name : "a site"}`}
            suggestions={suggestions}
          >
            Why its grade or price changed, how its worth is estimated, or how
            sure the rating is. She shows her sources.
          </BeaEmpty>
        )}
        {world.copilot.map((m) =>
          m.role === "user" ? (
            <BeaQuestion key={m.id}>{m.text}</BeaQuestion>
          ) : (
            <BeaAnswer
              key={m.id}
              state={m.citations.length > 0 ? "found" : "cant-answer"}
            >
              <p>
                {m.id === bzz && "Bzz. "}
                <Rich text={m.text} />
              </p>
              {m.citations.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/70 pt-2.5">
                  {m.citations.map((c) => (
                    <Link
                      key={c.label + c.href}
                      href={c.href}
                      onClick={closeCopilot}
                      className={SOURCE_CHIP}
                    >
                      {c.label}
                    </Link>
                  ))}
                </div>
              )}
            </BeaAnswer>
          ),
        )}
        {ui.copilotTyping && (
          <BeaAnswer state="thinking" bubble={false}>
            Bea is reading the Record…
          </BeaAnswer>
        )}
      </div>
      <div className="space-y-3 px-5 pt-2 pb-5">
        {world.copilot.length > 0 && (
          <div className="flex flex-wrap gap-1.5">{suggestions}</div>
        )}
        <BeaComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => submit(draft)}
          label="Ask Bea"
          placeholder={`Ask Bea about ${site ? site.name : "a site"}…`}
          sendDisabled={!draft.trim()}
          inputProps={{ "data-tour": "copilot-input" }}
        />
      </div>
    </>
  );
}
