import { NextRequest, NextResponse } from "next/server";
import { defaultMailboxPath, getRuntime } from "../../../src/server/runtime";
import { AUTONOMY_MODES, type ProjectInput } from "../../../src/core/types";

export const runtime = "nodejs";

export function GET() {
  const { db } = getRuntime();
  const projects = db.listProjects().map((project) => {
    const run = db.getLatestRun(project.id);
    return { ...project, latestRun: run ? { id: run.id, state: run.state, iterationCount: run.iterationCount, updatedAt: run.updatedAt } : undefined };
  });
  return NextResponse.json({ projects });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<ProjectInput>;
    const required = ["name", "localPath", "defaultBranch", "workingBranch", "testCommand", "autonomyMode"] as const;
    const missing = required.find((field) => typeof body[field] !== "string" || !body[field]?.trim());
    if (missing) return NextResponse.json({ error: `${missing} is required` }, { status: 400 });
    if (!AUTONOMY_MODES.includes(body.autonomyMode as typeof AUTONOMY_MODES[number])) return NextResponse.json({ error: "autonomyMode is invalid" }, { status: 400 });
    const { db, git } = getRuntime();
    const localPath = body.localPath as string;
    if (!git.isRepository(localPath)) return NextResponse.json({ error: "localPath must be an existing Git repository" }, { status: 400 });
    const project = db.createProject({
      name: body.name as string,
      localPath,
      remoteUrl: body.remoteUrl,
      defaultBranch: body.defaultBranch as string,
      workingBranch: body.workingBranch as string,
      testCommand: body.testCommand as string,
      lintCommand: body.lintCommand,
      typecheckCommand: body.typecheckCommand,
      buildCommand: body.buildCommand,
      autonomyMode: body.autonomyMode as typeof AUTONOMY_MODES[number],
      reviewMailboxPath: body.reviewMailboxPath?.trim() || defaultMailboxPath()
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create project" }, { status: 500 });
  }
}
