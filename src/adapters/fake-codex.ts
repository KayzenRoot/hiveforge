import { randomUUID } from "node:crypto";
import type { CodexAdapter, CodexLifecycleEvent } from "../core/types";

export class FakeCodexAdapter implements CodexAdapter {
  readonly provider = "fake" as const;
  readonly prompts: Array<{ threadId: string; prompt: string; cwd: string }> = [];
  readonly threads: string[] = [];
  readonly turns: Array<{ turnId: string; threadId: string; prompt: string; cwd: string }> = [];
  private eventHandler: (event: CodexLifecycleEvent) => void = () => undefined;

  setEventHandler(handler: (event: CodexLifecycleEvent) => void): void {
    this.eventHandler = handler;
  }

  async startThread(): Promise<{ threadId: string }> {
    const threadId = "fake-thread-" + randomUUID();
    this.threads.push(threadId);
    return { threadId };
  }

  async sendPrompt(input: { threadId: string; prompt: string; cwd: string }): Promise<{ turnId: string }> {
    this.prompts.push(input);
    const turnId = "fake-turn-" + randomUUID();
    this.turns.push({ turnId, ...input });
    return { turnId };
  }

  completeTurn(turnId = this.turns.at(-1)?.turnId): void {
    if (!turnId) throw new Error("No fake Codex turn is available");
    const turn = this.turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) throw new Error("Fake Codex turn not found: " + turnId);
    this.eventHandler({
      kind: "turn",
      threadId: turn.threadId,
      turnId,
      status: "completed",
      payload: { threadId: turn.threadId, turn: { id: turnId, status: "completed" } }
    });
  }

  failTurn(turnId = this.turns.at(-1)?.turnId, status: "failed" | "interrupted" = "failed"): void {
    if (!turnId) throw new Error("No fake Codex turn is available");
    const turn = this.turns.find((candidate) => candidate.turnId === turnId);
    if (!turn) throw new Error("Fake Codex turn not found: " + turnId);
    this.eventHandler({
      kind: "turn",
      threadId: turn.threadId,
      turnId,
      status,
      error: status === "failed" ? "fake Codex failure" : "fake Codex interruption",
      payload: { threadId: turn.threadId, turnId, status }
    });
  }
}
