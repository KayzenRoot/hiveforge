import { randomUUID } from "node:crypto";
import type { CodexAdapter } from "../core/types";

export class FakeCodexAdapter implements CodexAdapter {
  readonly provider = "fake" as const;
  readonly prompts: Array<{ threadId: string; prompt: string; cwd: string }> = [];
  readonly threads: string[] = [];

  async startThread(): Promise<{ threadId: string }> {
    const threadId = `fake-thread-${randomUUID()}`;
    this.threads.push(threadId);
    return { threadId };
  }

  async sendPrompt(input: { threadId: string; prompt: string; cwd: string }): Promise<{ turnId: string }> {
    this.prompts.push(input);
    return { turnId: `fake-turn-${randomUUID()}` };
  }
}
