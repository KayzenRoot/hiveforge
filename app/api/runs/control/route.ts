import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "../../../../src/server/runtime";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { runId?: string; action?: "pause" | "resume" | "stop" };
    if (!body.runId || !body.action) return NextResponse.json({ error: "runId and action are required" }, { status: 400 });
    const engine = getRuntime().engine;
    const run = body.action === "pause" ? engine.pause(body.runId) : body.action === "stop" ? engine.stop(body.runId) : await engine.resume(body.runId);
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not control run" }, { status: 400 });
  }
}
