import type { CopilotSource, CopilotStreamEvent } from "@/lib/api/types";

export const ASSET_ID = "33333333-3333-4333-8333-333333333301";
export const EVENT_ID = "55555555-5555-4555-8555-555555555501";

export const EVENT_SOURCE: CopilotSource = {
  ref: "E55555555",
  kind: "event",
  asset_id: ASSET_ID,
  asset_name: "Xochimilco wetland",
  title: "Industrial park expansion cleared near Xochimilco wetlands",
  snippet: "News event for Xochimilco wetland (source: tavily).",
  event_id: EVENT_ID,
  report_id: null,
  version: null,
};

export const REPORT_SOURCE: CopilotSource = {
  ref: "R2",
  kind: "report",
  asset_id: ASSET_ID,
  asset_name: "Xochimilco wetland",
  title: "Report v2",
  snippet: "Rating report version 2 for Xochimilco wetland.",
  event_id: null,
  report_id: "77777777-7777-4777-8777-777777777702",
  version: 2,
};

export const ANSWER =
  "An encroachment event was reported [E55555555], and health fell from 77.60 to 72.30 [R2].";

export function answerEvents(answer = ANSWER): CopilotStreamEvent[] {
  const words = answer.match(/\S+\s*/g) ?? [];
  return [
    { type: "sources", sources: [EVENT_SOURCE, REPORT_SOURCE] },
    ...words.map((text) => ({ type: "delta" as const, text })),
    {
      type: "done",
      answer,
      citations: [EVENT_SOURCE, REPORT_SOURCE],
      mode: "model",
      model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    },
  ];
}

/** The SSE wire format FastAPI's EventSourceResponse writes, split into odd-sized chunks. */
export function sseResponse(
  events: CopilotStreamEvent[],
  chunkSize = 17,
): Response {
  const wire =
    ": ping\n\n" + events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}
