import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeCodexAdapter } from "../src/adapters/fake-codex";
import { GitAdapter } from "../src/adapters/git";
import { EventBus } from "../src/core/event-bus";
import { Database } from "../src/db/database";
import { ReviewMailboxWatcher } from "../src/mailbox/watcher";
import { WorkflowEngine } from "../src/workflow/engine";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hiveforge-test-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git(["init", "-b", "main"]); git(["config", "user.email", "test@hiveforge.local"]); git(["config", "user.name", "HiveForge Test"]);
  writeFileSync(join(directory, "README.md"), "one\n"); git(["add", "."]); git(["commit", "-m", "one"]);
  writeFileSync(join(directory, "README.md"), "two\n"); git(["add", "."]); git(["commit", "-m", "two"]);
  return directory;
}

async function readyRun(mode: "AUTONOMOUS" | "GUARDED" | "CONTROLLED") {
  const directory = fixture();
  const db = new Database(":memory:");
  const fake = new FakeCodexAdapter();
  const engine = new WorkflowEngine(db, new GitAdapter(), new EventBus(), fake);
  const project = db.createProject({ name: mode, localPath: directory, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: mode, reviewMailboxPath: join(directory, ".mailbox") });
  const run = db.createRun({ projectId: project.id, autonomyMode: mode });
  await engine.start(run.id, "first"); await engine.markValidation(run.id);
  return { db, engine, fake, project, run: db.getRun(run.id)! };
}

describe("SQLite, Git, mailbox and workflow integration", () => {
  it("runs migrations and persists projects, runs and events", () => {
    const db = new Database(":memory:");
    const project = db.createProject({ name: "Persisted", localPath: "C:/repo", defaultBranch: "main", workingBranch: "main", testCommand: "npm test", autonomyMode: "AUTONOMOUS", reviewMailboxPath: "C:/mailbox" });
    const run = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
    db.appendEvent(run.id, "TEST", "persisted", "IDLE");
    expect(db.getProject(project.id)?.name).toBe("Persisted");
    expect(db.listEvents(run.id)).toHaveLength(1);
    expect(db.listNonTerminalRuns().map((item) => item.id)).toContain(run.id);
    db.close();
  });

  it("captures deterministic Git evidence and consumes mailbox JSON", async () => {
    const directory = fixture(); const mailbox = join(directory, ".mailbox"); mkdirSync(mailbox);
    const db = new Database(":memory:"); const fake = new FakeCodexAdapter(); const engine = new WorkflowEngine(db, new GitAdapter(), new EventBus(), fake);
    const project = db.createProject({ name: "Mailbox", localPath: directory, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: "AUTONOMOUS", reviewMailboxPath: mailbox });
    const run = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" }); await engine.start(run.id, "first"); await engine.markValidation(run.id);
    const waiting = db.getRun(run.id)!; const evidence = db.getLatestGitEvidence(run.id)!;
    writeFileSync(join(mailbox, "valid.json"), JSON.stringify({ protocol: "RCP", version: "0.1", review_id: "mailbox-review", project_id: project.id, run_id: run.id, work_order_id: waiting.workOrderId, decision: "APPROVED", action: "CONTINUE", head_sha: evidence.headSha, base_sha: evidence.baseSha, findings: [], executor_prompt: "second", created_at: new Date().toISOString() }));
    const watcher = new ReviewMailboxWatcher(mailbox, { onReview: async (review) => { const result = await engine.processReview(review); assert.equal(result.accepted, true); }, onRejected: () => { throw new Error("unexpected mailbox rejection"); } });
    await watcher.scan();
    expect(fake.prompts).toHaveLength(2); expect(db.getRun(run.id)?.state).toBe("CODEX_RUNNING");
    db.close();
  });

  it("uses approval gates for GUARDED and CONTROLLED", async () => {
    for (const mode of ["GUARDED", "CONTROLLED"] as const) {
      const context = await readyRun(mode); const { db, engine, project, run, fake } = context; const evidence = db.getLatestGitEvidence(run.id)!;
      const result = await engine.processReview({ protocol: "RCP", version: "0.1", review_id: `review-${mode}`, project_id: project.id, run_id: run.id, work_order_id: run.workOrderId, decision: "APPROVED", action: "CONTINUE", head_sha: evidence.headSha, base_sha: evidence.baseSha, findings: [], executor_prompt: "approved next", created_at: new Date().toISOString() });
      expect(result.run?.state).toBe("WAITING_APPROVAL"); expect(fake.prompts).toHaveLength(1);
      const approved = await engine.approveReview(`review-${mode}`); expect(approved.state).toBe("CODEX_RUNNING"); expect(fake.prompts).toHaveLength(2); db.close();
    }
  });

  it("recovery does not issue duplicate dispatches", async () => {
    const context = await readyRun("AUTONOMOUS"); const { db, engine, run, fake } = context; const before = fake.prompts.length; const recovered = engine.recover();
    expect(recovered.some((item) => item.id === run.id)).toBe(true); expect(fake.prompts.length).toBe(before); db.close();
  });
});
