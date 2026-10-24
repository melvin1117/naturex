/**
 * The Investor Copilot's answer stream (T39, `POST /copilot`).
 *
 * The backend answers over Server-Sent Events on a POST, which `EventSource` can't send, so the
 * body is read with `fetch` (through the typed client, so the world bootstrap and session
 * handling still apply) and parsed here. The stream is `sources` (what was retrieved), `delta`
 * pieces of the checked answer, then `done` with the full answer and its citations, or `error`.
 * Errors before the stream starts (401, 404, 422, 429 `copilot_rate_limited`, 503
 * `copilot_unavailable`) are thrown as `ApiError`.
 */
import type { ApiClient } from "./api/client";
import { ApiError, unwrap } from "./api/errors";
import type {
  CopilotRequest,
  CopilotSource,
  CopilotStreamEvent,
} from "./api/types";

/**
 * Incremental `text/event-stream` parser (https://html.spec.whatwg.org/multipage/server-sent-events.html):
 * feed text as it arrives, get each complete event's `data` back. Comment lines (`: ping`)
 * and other fields are ignored; multi-line data is joined with "\n".
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let newline = this.buffer.search(/\r\n|\r|\n/);
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith("\r\n", newline) ? 2 : 1;
      this.buffer = this.buffer.slice(newline + width);
      this.line(line, out);
      newline = this.buffer.search(/\r\n|\r|\n/);
    }
    return out;
  }

  /** The end of the stream: a last event without its blank line still counts. */
  flush(): string[] {
    const out: string[] = [];
    if (this.buffer) this.line(this.buffer, out);
    this.buffer = "";
    this.line("", out);
    return out;
  }

  private line(line: string, out: string[]) {
    if (line === "") {
      if (this.data.length) out.push(this.data.join("\n"));
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
  }
}

const EVENT_TYPES = new Set(["sources", "delta", "done", "error"]);

function parseEvent(data: string): CopilotStreamEvent | null {
  try {
    const event = JSON.parse(data) as { type?: unknown };
    return typeof event.type === "string" && EVENT_TYPES.has(event.type)
      ? (event as CopilotStreamEvent)
      : null;
  } catch {
    return null;
  }
}

/** Stream one question's answer, calling `onEvent` for each event in order. */
export async function askCopilot(
  api: ApiClient,
  body: CopilotRequest,
  {
    onEvent,
    signal,
  }: { onEvent: (event: CopilotStreamEvent) => void; signal?: AbortSignal },
): Promise<void> {
  const stream = await unwrap(
    api.POST("/copilot", { body, parseAs: "stream", signal }),
  );
  if (!stream) throw new ApiError(502, "Bea sent an empty answer.");
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const emit = (items: string[]) => {
    for (const item of items) {
      const event = parseEvent(item);
      if (event) onEvent(event);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      emit(parser.push(decoder.decode(value, { stream: true })));
    }
    emit(parser.push(decoder.decode()));
    emit(parser.flush());
  } finally {
    reader.releaseLock();
  }
}

export type AnswerPart =
  | { kind: "text"; text: string }
  | { kind: "citation"; ref: string; source: CopilotSource | null };

/**
 * Split an answer into text and `[ref]` citations. Like the backend's citation check, a
 * bracket is a citation only when its ref has a digit (`[R2]`, `[E1a2b3c4d]`) or names a
 * source, so `[Erosion]` stays text. A citation links only when `sources` has its ref (the
 * backend already removed every other one; this keeps the UI honest anyway).
 */
export function answerParts(
  answer: string,
  sources: readonly CopilotSource[],
): AnswerPart[] {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const parts: AnswerPart[] = [];
  const pattern = /\[([RE][0-9A-Za-z-]{1,40})\]/g;
  let last = 0;
  const text = (end: number) => {
    if (end > last) parts.push({ kind: "text", text: answer.slice(last, end) });
  };
  for (const match of answer.matchAll(pattern)) {
    const ref = match[1];
    if (!/\d/.test(ref) && !byRef.has(ref)) continue;
    const index = match.index ?? 0;
    text(index);
    parts.push({ kind: "citation", ref, source: byRef.get(ref) ?? null });
    last = index + match[0].length;
  }
  text(answer.length);
  return parts;
}

/** An answer's inline structure: text, citations and the emphasis around them. */
export type AnswerNode =
  | Extract<AnswerPart, { kind: "text" } | { kind: "citation" }>
  | { kind: "strong" | "em" | "code"; children: AnswerNode[] };

type Marker = "**" | "__" | "*" | "_" | "`";
type Token =
  | AnswerNode
  | { kind: "marker"; marker: Marker; open: boolean; close: boolean };

/** Stands for a citation while markers are matched: not whitespace, not a letter. */
const CITE = "\uE000";
const TOKEN = /\uE000|\*\*|__|\*|_|`/g;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;

/**
 * The answer as nodes to render, with inline Markdown the model or a quoted report may still
 * use: `**bold**`/`__bold__`, `*italic*`/`_italic_` and `` `code` ``, which may wrap citations
 * (`**fell [R1]**`). Everything else stays text, so nothing is ever rendered as HTML. Markers
 * follow CommonMark's flanking rules (`5 * 3` and `snake_case` stay as written); an unmatched
 * `**` or `__` (a quote cut mid-bold) is dropped, a leading `#` heading mark too.
 */
export function answerNodes(
  answer: string,
  sources: readonly CopilotSource[],
): AnswerNode[] {
  const text = answer.replace(/^#{1,6}[ \t]+/gm, "");
  const parts = answerParts(text, sources);
  const citations = parts.filter((p) => p.kind === "citation");
  const flat = parts
    .map((p) => (p.kind === "text" ? p.text.replaceAll(CITE, "") : CITE))
    .join("");
  const tokens: Token[] = [];
  let cited = 0;
  let last = 0;
  for (const match of flat.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ kind: "text", text: flat.slice(last, at) });
    last = at + match[0].length;
    if (match[0] === CITE) {
      tokens.push(citations[cited++]!);
      continue;
    }
    const marker = match[0] as Marker;
    const before = flat[at - 1] ?? "";
    const after = flat[last] ?? "";
    const left = after !== "" && !SPACE.test(after);
    const right = before !== "" && !SPACE.test(before);
    const underscore = marker[0] === "_";
    tokens.push({
      kind: "marker",
      marker,
      open: marker === "`" || (left && !(underscore && WORD.test(before))),
      close: marker === "`" || (right && !(underscore && WORD.test(after))),
    });
  }
  if (last < flat.length) tokens.push({ kind: "text", text: flat.slice(last) });
  return merge(nest(tokens));
}

const EMPHASIS: Record<Marker, "strong" | "em" | "code"> = {
  "**": "strong",
  __: "strong",
  "*": "em",
  _: "em",
  "`": "code",
};

function nest(tokens: Token[]): AnswerNode[] {
  const nodes: AnswerNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "marker") {
      nodes.push(token);
      continue;
    }
    const end = token.open
      ? tokens.findIndex(
          (t, j) =>
            j > i + 1 &&
            t.kind === "marker" &&
            t.marker === token.marker &&
            t.close,
        )
      : -1;
    if (end !== -1) {
      const inner = tokens.slice(i + 1, end);
      nodes.push({
        kind: EMPHASIS[token.marker],
        // Code is literal: markers inside it are text (citations still link).
        children: merge(
          token.marker === "`" ? inner.map(literal) : nest(inner),
        ),
      });
      i = end;
    } else if (token.marker !== "**" && token.marker !== "__") {
      nodes.push(literal(token));
    }
  }
  return nodes;
}

function literal(token: Token): AnswerNode {
  return token.kind === "marker" ? { kind: "text", text: token.marker } : token;
}

/** Adjacent text runs joined, so the rendered text reads as one. */
function merge(nodes: AnswerNode[]): AnswerNode[] {
  const out: AnswerNode[] = [];
  for (const node of nodes) {
    const prev = out.at(-1);
    if (node.kind === "text" && prev?.kind === "text")
      out[out.length - 1] = { kind: "text", text: prev.text + node.text };
    else out.push(node);
  }
  return out;
}

/** Where a citation leads: the asset page's report or news tab. */
export function sourceHref(source: CopilotSource): string {
  const tab = source.kind === "report" ? "report" : "news";
  return `/asset/${source.asset_id}?tab=${tab}`;
}

/**
 * "Proof of Life v2" or the event's title, for a citation chip. `withAsset` (the world-wide Copilot)
 * prefixes the site's name: "Xochimilco wetland · Proof of Life v2".
 */
export function sourceLabel(
  source: CopilotSource,
  { withAsset = false }: { withAsset?: boolean } = {},
): string {
  const label =
    source.kind === "report" && source.version != null
      ? `Proof of Life v${source.version}`
      : source.title;
  return withAsset ? `${source.asset_name} · ${label}` : label;
}
