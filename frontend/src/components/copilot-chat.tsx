"use client";

import { ArrowUp } from "lucide-react";
import Link from "@/components/app-link";
import { useSearchParams } from "next/navigation";
import { usePathname } from "@/lib/nav";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "cn";

import { Bea, type BeaState } from "@/components/bea/bea";
import { SLOW_AFTER_MS } from "@/components/loading-region";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isAbortError, toApiError } from "@/lib/api/errors";
import type { CopilotSource } from "@/lib/api/types";
import { loginHref } from "@/lib/auth";
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
 * site. Signed-out visitors are asked to sign in. `variant="sheet"` drops the card and its
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
  const inputId = useId();
  const { api } = useDataLayer();
  const { world } = useWorld();
  const pathname = usePathname();
  const search = useSearchParams().toString();
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

  if (!world?.me) {
    return (
      <Shell scope={scope} variant={variant}>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link href={loginHref(search ? `${pathname}?${search}` : pathname)}>
            Sign in to ask Bea
          </Link>
        </Button>
      </Shell>
    );
  }

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
          "space-y-4 overflow-y-auto overscroll-contain",
          sheet ? "min-h-0 flex-1 px-6 py-5" : "mt-4 max-h-[28rem]",
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
            sheet={sheet}
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
      <div className={cn(sheet && "border-t px-6 pt-3 pb-6")}>
        <div className={cn("flex flex-wrap gap-1.5", sheet ? "mb-3" : "mt-4")}>
          {suggestions.map((q) => (
            <Button
              key={q}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto rounded-full px-3 py-1.5 text-xs"
              disabled={pending}
              onClick={() => void ask(q)}
            >
              {q}
            </Button>
          ))}
        </div>
        <form
          className={cn("flex gap-2", !sheet && "mt-3")}
          onSubmit={(e) => {
            e.preventDefault();
            void ask(draft);
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {scope.kind === "asset"
              ? `Ask Bea about ${scope.assetName}`
              : "Ask Bea about every site"}
          </label>
          <Input
            id={inputId}
            value={draft}
            maxLength={MAX_QUESTION}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              scope.kind === "asset"
                ? "Why did it drop?"
                : "Which site fell most?"
            }
            className="rounded-full"
            autoComplete="off"
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send question"
            disabled={!draft.trim() || pending}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </form>
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
  children: ReactNode;
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
          ? "Bea, your field guide, answers only from this site's Record and links every claim to its source."
          : "Bea, your field guide, answers only from the Record of the sites in your world and links every claim to its source."}{" "}
        Play money only; not advice.
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
  sheet,
}: {
  scope: Scope;
  state: BeaState;
  /** The site's grade just moved: she hops or shakes once. */
  react: "up" | "down" | null;
  greeting: string | null;
  sheet: boolean;
}) {
  const about =
    scope.kind === "asset"
      ? `Ask about ${scope.assetName}: why its grade or price changed, how its worth is estimated, or what the news says.`
      : "Ask across every site: which were re-rated, what the news says, or how they compare. Answers link to each site's Proof of Life or news.";
  if (sheet)
    return (
      <div className="grid justify-items-center gap-2 px-2 pt-4 pb-2 text-center">
        <Bea state={state} size={96} react={react} label="" />
        <p className="font-serif text-2xl leading-tight">
          {scope.kind === "asset"
            ? `Ask Bea about ${scope.assetName}`
            : "Ask Bea about your sites"}
        </p>
        <p className="max-w-[34ch] text-sm text-muted-foreground">
          {greeting ?? about}
        </p>
      </div>
    );
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-secondary p-4 text-sm">
      <Bea state={state} size={40} react={react} label="" />
      <p>{greeting ? `${greeting} ${about}` : about}</p>
    </div>
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
  return (
    <div className="space-y-2">
      <p className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
        {turn.question}
      </p>
      <div className="flex items-end gap-2">
        <Bea
          state={turnState(turn, waking)}
          size={28}
          label=""
          className="mb-0.5"
        />
        <div className="max-w-[90%] min-w-0 rounded-2xl rounded-bl-md bg-secondary px-3.5 py-2.5 text-sm leading-relaxed">
          {turn.status === "searching" && <Working waking={waking} />}
          {turn.status === "writing" && !turn.answer && (
            <Working waking={false} sources={turn.sourcesFound} />
          )}
          {turn.status === "done" && <AnswerChips turn={turn} />}
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
            <div className="mt-2.5">
              <p className="text-xs text-muted-foreground">
                {turn.mode === "extractive"
                  ? "Quoted from the Record:"
                  : "Sources:"}
              </p>
              <ul
                className="mt-1 flex flex-wrap gap-1.5"
                aria-label="Sources of this answer"
              >
                {turn.citations.map((s) => (
                  <li key={s.ref} className="max-w-full min-w-0">
                    <Link
                      href={sourceHref(s)}
                      title={label(s)}
                      onClick={onNavigate}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-card px-2.5 py-1 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <span className="shrink-0 font-mono whitespace-nowrap text-muted-foreground">
                        {s.ref}
                      </span>
                      <span className="truncate">{label(s)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
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

function AnswerChips({ turn }: { turn: Turn }) {
  return (
    <ul
      className="mb-2 flex flex-wrap gap-1.5"
      aria-label="How this answer was made"
    >
      {answerChips(turn).map((chip) => (
        <li key={chip}>
          <Badge
            variant="outline"
            className="bg-card font-normal text-muted-foreground"
          >
            {chip}
          </Badge>
        </li>
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
            <code key={i} className="rounded bg-card px-1 font-mono text-xs">
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
              className="mx-0.5 rounded bg-card px-1 font-mono text-xs font-medium whitespace-nowrap underline-offset-2 hover:underline"
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
