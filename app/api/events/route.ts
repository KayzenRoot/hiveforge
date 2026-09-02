import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "../../../src/server/runtime";
import type { RunEvent } from "../../../src/core/types";

export const runtime = "nodejs";

function encode(event: RunEvent | Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n");
}

export function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId is required" }, { status: 400 });
  const { db, events } = getRuntime();
  if (!db.getRun(runId)) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (request.nextUrl.searchParams.get("stream") !== "1") return NextResponse.json({ events: db.listEvents(runId) });

  let unsubscribe: () => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let lastCreatedAt = "";
  let lastEventId = "";
  const seen = new Set<string>();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (event: RunEvent) => {
        if (closed || seen.has(event.id)) return;
        seen.add(event.id);
        lastCreatedAt = event.createdAt;
        lastEventId = event.id;
        controller.enqueue(encode(event));
      };
      for (const event of db.listEvents(runId, 250)) enqueue(event);
      unsubscribe = events.subscribe(runId, enqueue);
      poller = setInterval(() => {
        if (closed) return;
        for (const event of db.listEventsAfter(runId, lastCreatedAt, lastEventId, 250)) enqueue(event);
      }, 750);
      heartbeat = setInterval(() => { if (!closed) controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")); }, 15_000);
    },
    cancel() {
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      if (poller) clearInterval(poller);
    }
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
