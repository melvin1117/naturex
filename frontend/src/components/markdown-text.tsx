import { Fragment, type ReactNode } from "react";

/**
 * Renders LLM or web Markdown as React text: paragraphs, headings, bullet and numbered lists,
 * **bold**, *italic* and `code`. Raw HTML is never interpreted (it shows as literal text),
 * links show their text only, and `[id]` citations become small tags. No
 * `dangerouslySetInnerHTML`.
 */
export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return <div className={className}>{blocks(text)}</div>;
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      out.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      out.push({ kind: "heading", text: heading[1]!.replace(/#+\s*$/, "") });
    } else if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered && !bullet);
      const item = (bullet ?? numbered)![1]!;
      const last = out.at(-1);
      if (last?.kind === "list" && last.ordered === ordered)
        last.items.push(item);
      else out.push({ kind: "list", ordered, items: [item] });
    } else {
      const last = out.at(-1);
      // A wrapped list item continues on an indented line.
      if (!paragraph.length && last?.kind === "list" && /^\s+/.test(line))
        last.items[last.items.length - 1] += ` ${line.trim()}`;
      else paragraph.push(line.trim());
    }
  }
  flush();
  return out;
}

function blocks(text: string): ReactNode {
  return parseBlocks(text).map((block, i) => {
    if (block.kind === "heading")
      return (
        <p key={i} className="font-semibold">
          {inline(block.text)}
        </p>
      );
    if (block.kind === "paragraph") return <p key={i}>{inline(block.text)}</p>;
    const List = block.ordered ? "ol" : "ul";
    return (
      <List
        key={i}
        className={
          block.ordered
            ? "list-decimal space-y-1 pl-5"
            : "list-disc space-y-1 pl-5"
        }
      >
        {block.items.map((item, j) => (
          <li key={j}>{inline(item)}</li>
        ))}
      </List>
    );
  });
}

// Order matters: links before citations, bold before italic.
const INLINE =
  /(\[[^\]]+\]\([^)\s]*\)|\[[^\]\s][^\]]{0,80}\]|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;

function inline(text: string): ReactNode {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("[") && part.includes("](")) {
      return <Fragment key={i}>{part.slice(1, part.indexOf("]("))}</Fragment>;
    }
    if (part.startsWith("[") && part.endsWith("]"))
      return (
        <span
          key={i}
          className="mx-0.5 inline-block rounded-full bg-secondary px-1.5 font-mono text-[11px] leading-5 text-muted-foreground"
        >
          {part.slice(1, -1)}
        </span>
      );
    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*"))
      return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={i} className="font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    return <Fragment key={i}>{part}</Fragment>;
  });
}
