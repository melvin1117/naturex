import { describe, expect, it } from "vitest";

import { createApi } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import type { CopilotStreamEvent } from "@/lib/api/types";
import {
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
});
