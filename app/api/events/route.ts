import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "../../../src/server/runtime";
import type { RunEvent } from "../../../src/core/types";

export const runtime = "nodejs";

function encode(event: RunEvent | Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId is required" }, { status: 400 });
  const { db, events } = getRuntime();
  if (!db.getRun(runId)) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (request.nextUrl.searchParams.get("stream") !== "1") return NextResponse.json({ events: db.listEvents(runId) });

  let unsubscribe: () => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of db.listEvents(runId)) controller.enqueue(encode(event));
      unsubscribe = events.subscribe(runId, (event) => { if (!closed) controller.enqueue(encode(event)); });
      heartbeat = setInterval(() => { if (!closed) controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")); }, 15_000);
    },
    cancel() {
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    }
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
