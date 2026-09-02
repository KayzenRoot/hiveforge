import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { GET } from "../app/api/events/route";
import { getRuntime } from "../src/server/runtime";

describe("SSE event endpoint", () => {
  it("replays persisted events and remains subscribed", async () => {
    const runtime = getRuntime();
    const project = runtime.db.createProject({ name: `SSE ${Date.now()}`, localPath: "C:/fixture", defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: "AUTONOMOUS", reviewMailboxPath: "C:/mailbox" });
    const run = runtime.db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
    runtime.db.appendEvent(run.id, "REPLAYED", "from SQLite", "IDLE");
    const replay = GET(new NextRequest(`http://localhost/api/events?runId=${run.id}`));
    const replayPayload = await replay.json() as { events: Array<{ type: string }> };
    expect(replayPayload.events[0]?.type).toBe("REPLAYED");

    const streamResponse = GET(new NextRequest(`http://localhost/api/events?runId=${run.id}&stream=1`));
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = streamResponse.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("REPLAYED");
    await reader.cancel();
  });
});

afterAll(() => { getRuntime().db.close(); });
