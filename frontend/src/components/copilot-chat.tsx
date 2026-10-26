"use client";

import Link from "@/components/app-link";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "cn";

import type { BeaState } from "@/components/bea/bea";
import {
  BeaAnswer,
  BeaComposer,
  BeaEmpty,
  BeaQuestion,
  BeaSuggestion,
  SOURCE_CHIP,
} from "@/components/bea/chat-parts";
import { SLOW_AFTER_MS } from "@/components/loading-region";
import { isAbortError, toApiError } from "@/lib/api/errors";
import type { CopilotSource } from "@/lib/api/types";
import {
  answerNodes,
  askCopilot,
  type AnswerNode,
  sourceHref,
  sourceLabel,
} from "@/lib/copilot";
import {
  turnState,
  beaState,
  bzzTurnId,
  gradeChange,
  greetingFor,
} from "@/lib/bea";
import { useDataLayer } from "@/lib/data-layer";
import { useAssetReports, useWorld } from "@/lib/hooks";
import { modelLabel } from "@/lib/trace-view";

export const COPILOT_SUGGESTIONS = [
  "Why did the price change?",
  "What drives this grade?",
  "How is the value estimated?",
];

/** For Bea across every site (the portfolio page). */
export const WORLD_COPILOT_SUGGESTIONS = [
  "Which sites were downgraded?",
  "What news is affecting these sites?",
  "Which site has the healthiest nature?",
];

const MAX_QUESTION = 500;

type Status = "searching" | "writing" | "done" | "error";

interface Turn {
  id: number;
  question: string;
  answer: string;
  status: Status;
  sourcesFound: number;
  citations: CopilotSource[];
  mode: "model" | "extractive" | "refusal" | null;
  /** The Token Factory model that wrote a `model` answer. */
  model: string | null;
  error: string | null;
  /** Asked world-wide: its citation chips name their site. */
  worldWide: boolean;
}

/** Where the chat sits: a card on a page, or the body of the header's Bea sheet. */
type Layout = {
  /** A card with its own heading and description (asset and portfolio pages). */
  variant?: "card" | "sheet";
  /** Called when a source link is followed (the sheet closes). */
  onNavigate?: () => void;
  /** Told when an answer starts and ends (the sheet locks its scope meanwhile). */
  onPendingChange?: (pending: boolean) => void;
  /** Told which state Bea is in, for her avatar in the sheet's title. */
  onBeaStateChange?: (state: BeaState) => void;
};

/**
 * Bea, the field guide (T39, T44; was the Copilot): streamed answers grounded in the site's
 * Record (reports and news), with every `[ref]` linking to its source. With `assetId` she
 * answers about that site, and greets it with its latest grade change; without it (the
 * portfolio page) she searches every site visible in the world, and each citation names its
 * site. Before the sandbox has a person it renders nothing. `variant="sheet"` drops the card and its
 * heading for the header's Bea sheet (#213), whose scope can change between questions:
 * earlier answers stay. Bea's state follows the conversation (lib/bea.ts).
 */
export function CopilotChat(
  props: Layout &
    ({ assetId: string; assetName: string } | { assetId?: undefined }),
) {
  const assetId = props.assetId;
  const scope: Scope = props.assetId
    ? { kind: "asset", assetName: props.assetName }
    : { kind: "world" };
  const variant = props.variant ?? "card";
  const onNavigate = props.onNavigate;
  const onPendingChange = props.onPendingChange;
  const onBeaStateChange = props.onBeaStateChange;
  const { api } = useDataLayer();
  const { world } = useWorld();
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const pending = turns.some(
    (t) => t.status === "searching" || t.status === "writing",
  );
  const reports = useAssetReports(assetId);
  const change = assetId ? gradeChange(reports.data) : null;
  // No word from the server for a while: the free-tier backend is waking up.
  const searching = turns[turns.length - 1]?.status === "searching";
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    setWaking(false);
    if (!searching) return;
    const timer = window.setTimeout(() => setWaking(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [searching, turns.length]);
  const bea = beaState(turns, { waking, change });
  const bzz = bzzTurnId(turns);

  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  useEffect(() => {
    onBeaStateChange?.(bea);
  }, [bea, onBeaStateChange]);

  // Follow the conversation: a streamed answer and its source links end at the bottom.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [turns]);

  // Bea lives in the sandbox, whose gate opens a session first.
  if (!world?.me) return <Shell scope={scope} variant={variant} />;

  function update(id: number, patch: (turn: Turn) => Partial<Turn>) {
    setTurns((all) =>
      all.map((t) => (t.id === id ? { ...t, ...patch(t) } : t)),
    );
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || pending) return;
    const id = nextId.current++;
    setDraft("");
    setTurns((all) => [
      ...all,
      {
        id,
        question: q,
        answer: "",
        status: "searching",
        sourcesFound: 0,
        citations: [],
        mode: null,
        model: null,
        error: null,
        worldWide: !assetId,
      },
    ]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await askCopilot(
        api,
        assetId ? { question: q, asset_id: assetId } : { question: q },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "sources")
              update(id, () => ({
                status: "writing",
                sourcesFound: event.sources.length,
              }));
            else if (event.type === "delta")
              update(id, (t) => ({ answer: t.answer + event.text }));
            else if (event.type === "done")
              update(id, () => ({
                status: "done",
                answer: event.answer,
                citations: event.citations,
                mode: event.mode,
                model: event.model ?? null,
              }));
            else
              update(id, () => ({
                status: "error",
                error: "Bea couldn't finish this answer. Try again.",
              }));
          },
        },
      );
      update(id, (t) =>
        t.status === "done" || t.status === "error"
          ? {}
          : {
              status: "error",
              error: "The answer was cut off. Try again.",
            },
      );
    } catch (error) {
      if (isAbortError(error)) return;
      update(id, () => ({
        status: "error",
        error: toApiError(error).message,
      }));
    }
  }

  const suggestions =
    scope.kind === "asset" ? COPILOT_SUGGESTIONS : WORLD_COPILOT_SUGGESTIONS;
  const sheet = variant === "sheet";
  return (
    <Shell scope={scope} variant={variant}>
      <div
        ref={listRef}
        data-testid="copilot-turns"
        className={cn(
          "space-y-5 overflow-y-auto overscroll-contain",
          sheet
            ? "min-h-0 flex-1 px-5 py-5"
            : "mt-5 max-h-[30rem] rounded-2xl bg-background p-4",
        )}
        aria-live="polite"
        aria-busy={pending}
      >
        {turns.length === 0 && (
          <Hello
            scope={scope}
            state={bea}
            react={change?.direction ?? null}
            greeting={
              change && scope.kind === "asset"
                ? greetingFor(scope.assetName, change)
                : null
            }
            compact={!sheet}
            suggestions={suggestions.map((q) => (
              <BeaSuggestion key={q} onClick={() => void ask(q)}>
                {q}
              </BeaSuggestion>
            ))}
          />
        )}
        {turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            waking={waking}
            bzz={turn.id === bzz}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      <div className={cn(sheet ? "px-5 pt-2 pb-5" : "mt-4")}>
        <BeaComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void ask(draft)}
          maxLength={MAX_QUESTION}
          label={
            scope.kind === "asset"
              ? `Ask Bea about ${scope.assetName}`
              : "Ask Bea about every site"
          }
          placeholder={
            scope.kind === "asset"
              ? `Ask Bea about ${scope.assetName}…`
              : "Ask Bea about your sites…"
          }
          sendDisabled={!draft.trim() || pending}
        />
      </div>
    </Shell>
  );
}

type Scope = { kind: "asset"; assetName: string } | { kind: "world" };

function Shell({
  scope,
  variant,
  children,
}: {
  scope: Scope;
  variant: "card" | "sheet";
  children?: ReactNode;
}) {
  const titleId = useId();
  // The sheet has its own title and description.
  if (variant === "sheet")
    return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-3xl bg-card p-6 shadow-soft"
    >
      <h2 id={titleId} className="text-base font-semibold">
        Ask Bea
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {scope.kind === "asset"
          ? "Your field guide. She answers only from this site's Record and links every claim to its source."
          : "Your field guide. She answers only from the Record of the sites in your world and links every claim to its source."}
      </p>
      {children}
    </section>
  );
}

/** Bea's greeting before the first question: her state, and the site's grade change if any. */
function Hello({
  scope,
  state,
  react,
  greeting,
  compact,
  suggestions,
}: {
  scope: Scope;
  state: BeaState;
  /** The site's grade just moved: she hops or shakes once. */
  react: "up" | "down" | null;
  greeting: string | null;
  compact: boolean;
  suggestions: ReactNode;
}) {
  const about =
    scope.kind === "asset"
      ? "Why its grade or price changed, how its worth is estimated, or what the news says."
      : "Ask across every site: which were re-rated, what the news says, or how they compare. Answers link to each site's Proof of Life or news.";
  return (
    <BeaEmpty
      state={state}
      react={react}
      compact={compact}
      title={
        scope.kind === "asset"
          ? `Ask Bea about ${scope.assetName}`
          : "Ask Bea about your sites"
      }
      suggestions={suggestions}
    >
      {greeting ? `${greeting} ${about}` : about}
    </BeaEmpty>
  );
}

/** What Bea is doing while she works (her avatar beside the bubble shows it too). */
function Working({ waking, sources }: { waking: boolean; sources?: number }) {
  return (
    <span className="text-muted-foreground">
      {waking
        ? "Bea is waking up…"
        : sources === undefined
          ? "Bea is reading the Record…"
          : `Bea is reading ${sources} ${sources === 1 ? "source" : "sources"}…`}
    </span>
  );
}

function TurnView({
  turn,
  waking,
  bzz,
  onNavigate,
}: {
  turn: Turn;
  waking: boolean;
  /** Her first answer of the conversation opens with "Bzz" (ux-writing §6). */
  bzz: boolean;
  onNavigate: (() => void) | undefined;
}) {
  const label = (s: CopilotSource) =>
    sourceLabel(s, { withAsset: turn.worldWide });
  const working =
    turn.status === "searching" || (turn.status === "writing" && !turn.answer);
  return (
    <div className="space-y-3">
      <BeaQuestion>{turn.question}</BeaQuestion>
      {working ? (
        <BeaAnswer state={turnState(turn, waking)} bubble={false}>
          {turn.status === "searching" ? (
            <Working waking={waking} />
          ) : (
            <Working waking={false} sources={turn.sourcesFound} />
          )}
        </BeaAnswer>
      ) : (
        <BeaAnswer
          state={turnState(turn, waking)}
          meta={turn.status === "done" ? <AnswerChips turn={turn} /> : null}
        >
          {turn.answer && (
            <p>
              {bzz && "Bzz. "}
              <AnswerText
                text={turn.answer}
                sources={turn.citations}
                label={label}
                onNavigate={onNavigate}
              />
            </p>
          )}
          {turn.status === "error" && (
            <p role="alert" className="text-destructive">
              {turn.error}
            </p>
          )}
          {turn.status === "done" && turn.citations.length > 0 && (
            <div className="mt-3 border-t border-border/70 pt-2.5">
              <p className="text-[11px] text-muted-foreground">
                {turn.mode === "extractive"
                  ? "Quoted from the Record:"
                  : "Sources:"}
              </p>
              <ul
                className="mt-1.5 flex flex-wrap gap-1.5"
                aria-label="Sources of this answer"
              >
                {turn.citations.map((s) => (
                  <li key={s.ref} className="max-w-full min-w-0">
                    <Link
                      href={sourceHref(s)}
                      title={label(s)}
                      onClick={onNavigate}
                      className={SOURCE_CHIP}
                    >
                      <span className="shrink-0 font-mono whitespace-nowrap text-lime-ink">
                        {s.ref}
                      </span>
                      <span className="truncate">{label(s)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </BeaAnswer>
      )}
    </div>
  );
}

/** What a finished answer used, in plain words: the search, who wrote it, what code checked. */
export function answerChips(
  turn: Pick<Turn, "sourcesFound" | "mode" | "model" | "citations">,
): string[] {
  const n = turn.sourcesFound;
  const chips = [
    `Searched the Record · ${n} ${n === 1 ? "source" : "sources"}`,
  ];
  if (turn.mode === "model") chips.push(`Written by ${modelLabel(turn.model)}`);
  else if (turn.mode === "extractive") chips.push("Quoted by code, no model");
  else if (turn.mode === "refusal") chips.push("Not in the Record");
  if (turn.mode !== "refusal") {
    const c = turn.citations.length;
    chips.push(
      c
        ? `Code checked ${c} ${c === 1 ? "citation" : "citations"}`
        : "No citation to check",
    );
  }
  return chips;
}

/** How the answer was made, as a quiet machine footnote under the bubble. */
function AnswerChips({ turn }: { turn: Turn }) {
  return (
    <ul
      className="mt-1.5 flex flex-wrap gap-x-1.5 gap-y-0.5 px-1 font-mono text-[10.5px] leading-snug text-muted-foreground [&>li:not(:last-child)]:after:ml-1.5 [&>li:not(:last-child)]:after:opacity-50 [&>li:not(:last-child)]:after:content-['|']"
      aria-label="How this answer was made"
    >
      {answerChips(turn).map((chip) => (
        <li key={chip}>{chip}</li>
      ))}
    </ul>
  );
}

/**
 * The answer with each `[ref]` as a link to its source once the citations are known, and its
 * inline bold, italic and code as React elements (never HTML).
 */
function AnswerText({
  text,
  sources,
  label,
  onNavigate,
}: {
  text: string;
  sources: CopilotSource[];
  label: (source: CopilotSource) => string;
  onNavigate: (() => void) | undefined;
}) {
  const render = (nodes: AnswerNode[]): ReactNode[] =>
    nodes.map((node, i) => {
      switch (node.kind) {
        case "text":
          return <Fragment key={i}>{node.text}</Fragment>;
        case "strong":
          return (
            <strong key={i} className="font-semibold">
              {render(node.children)}
            </strong>
          );
        case "em":
          return <em key={i}>{render(node.children)}</em>;
        case "code":
          return (
            <code
              key={i}
              className="rounded bg-background px-1 font-mono text-xs"
            >
              {render(node.children)}
            </code>
          );
        case "citation":
          return node.source ? (
            <Link
              key={i}
              href={sourceHref(node.source)}
              onClick={onNavigate}
              aria-label={`Source ${node.ref}: ${label(node.source)}`}
              className="mx-0.5 rounded bg-background px-1 font-mono text-xs font-medium whitespace-nowrap text-lime-ink underline decoration-lime-ink/40 underline-offset-2 hover:decoration-lime-ink"
            >
              {node.ref}
            </Link>
          ) : (
            <span
              key={i}
              className="mx-0.5 font-mono text-xs whitespace-nowrap text-muted-foreground"
            >
              {node.ref}
            </span>
          );
      }
    });
  return <>{render(answerNodes(text, sources))}</>;
}
