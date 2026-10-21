import { describe, expect, it } from "vitest";

import { createApi } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import type { CopilotStreamEvent } from "@/lib/api/types";
import {
  answerNodes,
  answerParts,
  askCopilot,
  SseParser,
  sourceHref,
  sourceLabel,
} from "@/lib/copilot";

import { BASE, fakeBackend, json } from "../lib/helpers";
import {
  ANSWER,
  answerEvents,
  ASSET_ID,
  EVENT_SOURCE,
  REPORT_SOURCE,
  sseResponse,
} from "./fixtures";

describe("SseParser", () => {
  it("assembles events split across chunks and skips comments", () => {
    const parser = new SseParser();
    const out = [
      ...parser.push(": ping\n\nda"),
      ...parser.push('ta: {"a":1}\r'),
      ...parser.push("\n\r\ndata: x\ndata:y\n"),
      ...parser.push("\nevent: other\nid: 3\n\n"),
    ];

    expect(out).toEqual(['{"a":1}', "x\ny"]);
  });

  it("flushes a last event without its blank line", () => {
    const parser = new SseParser();
    expect(parser.push("data: last")).toEqual([]);
    expect(parser.flush()).toEqual(["last"]);
  });
});

describe("askCopilot", () => {
  function api(handler: (request: Request) => Response | Promise<Response>) {
    const backend = fakeBackend({ "POST /copilot": handler });
    return {
      backend,
      client: createApi({ baseUrl: BASE, fetch: backend.fetch, session: null }),
    };
  }

  it("streams typed events in order and posts the question", async () => {
    const { backend, client } = api(() => sseResponse(answerEvents(), 7));
    const seen: CopilotStreamEvent[] = [];

    await askCopilot(
      client,
      { question: "Why did the price drop?", asset_id: ASSET_ID },
      { onEvent: (e) => seen.push(e) },
    );

    expect(seen[0]).toEqual({
      type: "sources",
      sources: [EVENT_SOURCE, REPORT_SOURCE],
    });
    const deltas = seen.filter((e) => e.type === "delta");
    expect(deltas.map((e) => e.text).join("")).toBe(ANSWER);
    expect(seen.at(-1)).toMatchObject({ type: "done", answer: ANSWER });
    const [request] = backend.requests;
    expect(await request!.json()).toEqual({
      question: "Why did the price drop?",
      asset_id: ASSET_ID,
    });
  });

  it("throws an ApiError with a friendly message before the stream", async () => {
    const { client } = api(() =>
      json({ detail: "copilot_rate_limited" }, { status: 429 }),
    );

    const error = await askCopilot(
      client,
      { question: "Why?" },
      { onEvent: () => {} },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("copilot_rate_limited");
    expect((error as ApiError).message).toMatch(/answered a lot of questions/);
  });
});

describe("answerParts", () => {
  it("links only the refs it has sources for", () => {
    const parts = answerParts("Fell [R2] after [E55555555] and [E00000000].", [
      EVENT_SOURCE,
      REPORT_SOURCE,
    ]);

    expect(parts).toEqual([
      { kind: "text", text: "Fell " },
      { kind: "citation", ref: "R2", source: REPORT_SOURCE },
      { kind: "text", text: " after " },
      { kind: "citation", ref: "E55555555", source: EVENT_SOURCE },
      { kind: "text", text: " and " },
      { kind: "citation", ref: "E00000000", source: null },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves bracketed words without a digit as text", () => {
    expect(
      answerParts("[Erosion] and [Rain] after [R2].", [REPORT_SOURCE]),
    ).toEqual([
      { kind: "text", text: "[Erosion] and [Rain] after " },
      { kind: "citation", ref: "R2", source: REPORT_SOURCE },
      { kind: "text", text: "." },
    ]);
  });

  it("builds links to the report and news tabs", () => {
    expect(sourceHref(REPORT_SOURCE)).toBe(`/asset/${ASSET_ID}?tab=report`);
    expect(sourceHref(EVENT_SOURCE)).toBe(`/asset/${ASSET_ID}?tab=news`);
    expect(sourceLabel(REPORT_SOURCE)).toBe("Report v2");
    expect(sourceLabel(EVENT_SOURCE)).toBe(EVENT_SOURCE.title);
  });

  it("names the site in a world-wide answer's citation labels", () => {
    expect(sourceLabel(REPORT_SOURCE, { withAsset: true })).toBe(
      `${REPORT_SOURCE.asset_name} · Report v2`,
    );
    expect(sourceLabel(EVENT_SOURCE, { withAsset: true })).toBe(
      `${EVENT_SOURCE.asset_name} · ${EVENT_SOURCE.title}`,
    );
    expect(sourceLabel(REPORT_SOURCE, { withAsset: false })).toBe("Report v2");
  });
});

describe("answerNodes", () => {
  const sources = [REPORT_SOURCE, EVENT_SOURCE];
  const r2 = { kind: "citation", ref: "R2", source: REPORT_SOURCE } as const;

  it("keeps plain text and citations as they are", () => {
    expect(answerNodes("Health fell [R2].", sources)).toEqual([
      { kind: "text", text: "Health fell " },
      r2,
      { kind: "text", text: "." },
    ]);
  });

  it("renders bold, italic and code, with a citation inside bold still a citation", () => {
    expect(
      answerNodes(
        "Health **fell [R2]** after *heavy* rain and `NDVI` data.",
        sources,
      ),
    ).toEqual([
      { kind: "text", text: "Health " },
      { kind: "strong", children: [{ kind: "text", text: "fell " }, r2] },
      { kind: "text", text: " after " },
      { kind: "em", children: [{ kind: "text", text: "heavy" }] },
      { kind: "text", text: " rain and " },
      { kind: "code", children: [{ kind: "text", text: "NDVI" }] },
      { kind: "text", text: " data." },
    ]);
  });

  it("nests italic in bold and accepts underscores", () => {
    expect(answerNodes("__very *much* so__", [])).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "very " },
          { kind: "em", children: [{ kind: "text", text: "much" }] },
          { kind: "text", text: " so" },
        ],
      },
    ]);
  });

  it("leaves arithmetic, snake_case and lone markers as text", () => {
    expect(
      answerNodes("5 * 3 = 15 for land_cover_v2 and a * star", []),
    ).toEqual([
      { kind: "text", text: "5 * 3 = 15 for land_cover_v2 and a * star" },
    ]);
  });

  it("drops a quote's unmatched bold markers and heading marks", () => {
    expect(
      answerNodes(
        "## Value\nEstimated services: **$2.4M to $33.8M a year [R2]",
        sources,
      ),
    ).toEqual([
      {
        kind: "text",
        text: "Value\nEstimated services: $2.4M to $33.8M a year ",
      },
      r2,
    ]);
  });

  it("renders a quoted report's bold value range cleanly", () => {
    const nodes = answerNodes(
      "Estimated ecosystem services: **$2,466,117 to $33,801,307 a year** (mid $33,801,307). [R2]",
      sources,
    );
    expect(nodes[1]).toEqual({
      kind: "strong",
      children: [{ kind: "text", text: "$2,466,117 to $33,801,307 a year" }],
    });
    expect(JSON.stringify(nodes)).not.toContain("**");
  });

  it("never turns text into markup", () => {
    expect(answerNodes("<img src=x onerror=alert(1)> [R2]", sources)).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)> " },
      r2,
    ]);
  });
});
