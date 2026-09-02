import { join } from "node:path";
import { CodexAppServerAdapter } from "../adapters/codex";
import { GitAdapter } from "../adapters/git";
import { EventBus } from "../core/event-bus";
import { Database } from "../db/database";
import { WorkflowEngine } from "../workflow/engine";

export interface HiveforgeRuntime {
  db: Database;
  events: EventBus;
  git: GitAdapter;
  codex: CodexAppServerAdapter;
  engine: WorkflowEngine;
}

const globalRuntime = globalThis as typeof globalThis & { __hiveforgeRuntime?: HiveforgeRuntime };

export function getRuntime(): HiveforgeRuntime {
  if (!globalRuntime.__hiveforgeRuntime) {
    const events = new EventBus();
    const db = new Database();
    const git = new GitAdapter();
    const codex = new CodexAppServerAdapter();
    const engine = new WorkflowEngine(db, git, events, codex);
    globalRuntime.__hiveforgeRuntime = { db, events, git, codex, engine };
    engine.recover();
  }
  return globalRuntime.__hiveforgeRuntime;
}

export function defaultMailboxPath(): string {
  return process.env.HIVEFORGE_MAILBOX_PATH ?? join(process.cwd(), "data", "mailbox");
}
