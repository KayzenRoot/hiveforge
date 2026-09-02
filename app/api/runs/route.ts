import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "../../../src/server/runtime";
import type { AutonomyMode } from "../../../src/core/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const { db, codex, engine } = getRuntime();
  const body = await request.json() as { projectId?: string; prompt?: string };
  if (!body.projectId || !body.prompt) return NextResponse.json({ error: "projectId and prompt are required" }, { status: 400 });
  const project = db.getProject(body.projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const probe = codex.probe();
  if (!probe.available) return NextResponse.json({ error: "Codex App Server is not configured; run the official Codex login flow first" }, { status: 503 });
  const run = db.createRun({ projectId: project.id, autonomyMode: project.autonomyMode as AutonomyMode });
  try {
    const started = await engine.start(run.id, body.prompt);
    return NextResponse.json({ run: started }, { status: 201 });
  } catch (error) {
    db.run("UPDATE runs SET state = 'FAILED', updated_at = ? WHERE id = ?", new Date().toISOString(), run.id);
    const failed = db.appendEvent(run.id, "RUN_FAILED", error instanceof Error ? error.message : String(error), "FAILED");
    getRuntime().events.publish(failed);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not start run", runId: run.id }, { status: 500 });
  }
}
