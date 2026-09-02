import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeCodexAdapter } from "../src/adapters/fake-codex";
import { GitAdapter } from "../src/adapters/git";
import { EventBus } from "../src/core/event-bus";
import { serializeReviewContract } from "../src/core/rcp";
import type { ReviewContract } from "../src/core/types";
import { Database } from "../src/db/database";
import { ReviewMailboxWatcher } from "../src/mailbox/watcher";
import { WorkflowEngine } from "../src/workflow/engine";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hiveforge-test-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git(["init", "-b", "main"]); git(["config", "user.email", "test@hiveforge.local"]); git(["config", "user.name", "HiveForge Test"]);
  writeFileSync(join(directory, "README.md"), "base\n"); git(["add", "."]); git(["commit", "-m", "base"]);
  return { directory, git, baseSha: git(["rev-parse", "HEAD"]) };
}

async function settle(db: Database, runId: string) {
  for (let index = 0; index < 100; index += 1) {
    const state = db.getRun(runId)?.state;
    if (state === "WAITING_REVIEW" || state === "BLOCKED") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("workflow did not settle for run " + runId);
}

async function readyRun(mode: "AUTONOMOUS" | "GUARDED" | "CONTROLLED") {
  const context = fixture();
  const mailbox = join(context.directory, ".mailbox");
  mkdirSync(mailbox);
  const db = new Database(":memory:");
  const fake = new FakeCodexAdapter();
  const engine = new WorkflowEngine(db, new GitAdapter(), new EventBus(), fake);
  const project = db.createProject({ name: mode, localPath: context.directory, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: mode, reviewMailboxPath: mailbox });
  const run = db.createRun({ projectId: project.id, autonomyMode: mode });
  await engine.start(run.id, "first");
  fake.completeTurn();
  await settle(db, run.id);
  return { ...context, db, engine, fake, project, run: db.getRun(run.id)! };
}

function makeReview(run: Awaited<ReturnType<typeof readyRun>>, overrides: Partial<ReviewContract> = {}): ReviewContract {
  const evidence = run.db.getLatestGitEvidence(run.run.id)!;
  return { schemaVersion: "0.1", reviewId: "review-" + run.run.id, projectId: run.project.id, workOrderId: run.run.workOrderId, baseSha: evidence.baseSha, headSha: evidence.headSha, verdict: "APPROVED", progressPercent: 60, summary: "Increment reviewed", findings: [], nextAction: "CONTINUE", executorPrompt: "approved next", checkpointNote: "Evidence locked", ...overrides };
}

describe("SQLite, Git, mailbox and workflow integration", () => {
  it("persists projects, runs, durable turns, validation results and events", async () => {
    const context = await readyRun("AUTONOMOUS");
    expect(context.db.getRun(context.run.id)?.state).toBe("WAITING_REVIEW");
    expect(context.db.getActiveCodexTurn(context.run.id)).toBeUndefined();
    expect(context.db.getValidationResults(context.run.id).find((item) => item.kind === "test")?.status).toBe("PASS");
    expect(context.db.listEvents(context.run.id).map((item) => item.type)).toEqual(expect.arrayContaining(["RUN_BASE_CAPTURED", "CODEX_TURN_COMPLETED", "VALIDATION_COMPLETED", "GIT_EVIDENCE_CAPTURED"]));
    context.db.close();
  });

  it("captures the complete multi-commit work-order diff from the base SHA", async () => {
    const context = fixture();
    const db = new Database(":memory:");
    const fake = new FakeCodexAdapter();
    const engine = new WorkflowEngine(db, new GitAdapter(), new EventBus(), fake);
    const project = db.createProject({ name: "Multi commit", localPath: context.directory, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: "AUTONOMOUS", reviewMailboxPath: join(context.directory, ".mailbox") });
    const run = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
    await engine.start(run.id, "multi-commit");
    writeFileSync(join(context.directory, "README.md"), "commit one\n"); context.git(["add", "."]); context.git(["commit", "-m", "commit one"]);
    writeFileSync(join(context.directory, "README.md"), "commit two\n"); context.git(["add", "."]); context.git(["commit", "-m", "commit two"]);
    fake.completeTurn(); await settle(db, run.id);
    const evidence = db.getLatestGitEvidence(run.id)!;
    expect(evidence.baseSha).toBe(context.baseSha);
    expect(evidence.headSha).toBe(context.git(["rev-parse", "HEAD"]));
    expect(evidence.changedFiles).toContain("README.md");
    expect(evidence.isClean).toBe(true);
    db.close();
  });

  it("rejects a dirty starting tree", async () => {
    const context = fixture();
    const db = new Database(":memory:");
    const fake = new FakeCodexAdapter();
    const engine = new WorkflowEngine(db, new GitAdapter(), new EventBus(), fake);
    const project = db.createProject({ name: "Dirty", localPath: context.directory, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: "AUTONOMOUS", reviewMailboxPath: join(context.directory, ".mailbox") });
    const run = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
    writeFileSync(join(context.directory, "README.md"), "uncommitted\n");
    await expect(engine.start(run.id, "must fail closed")).rejects.toThrow("clean committed Git state");
    expect(db.getRun(run.id)?.state).toBe("IDLE");
    db.close();
  });

  it("consumes a canonical mailbox review and dispatches the next turn", async () => {
    const context = await readyRun("AUTONOMOUS");
    const mailbox = join(context.directory, ".mailbox");
    const review = makeReview(context, { reviewId: "mailbox-review" });
    const watcher = new ReviewMailboxWatcher(mailbox, {
      onReview: async (value) => { const result = await context.engine.processReview(value); if (!result.accepted) throw new Error(result.errors.join("; ")); },
      onRejected: ({ errors }) => { throw new Error("unexpected mailbox rejection: " + errors.join("; ")); }
    });
    writeFileSync(join(mailbox, "valid.json"), JSON.stringify(serializeReviewContract(review)));
    await watcher.scan();
    expect(context.fake.prompts).toHaveLength(2);
    expect(context.db.getRun(context.run.id)?.state).toBe("CODEX_RUNNING");
    watcher.stop(); context.db.close();
  });

  it("uses approval gates for GUARDED and CONTROLLED", async () => {
    for (const mode of ["GUARDED", "CONTROLLED"] as const) {
      const context = await readyRun(mode);
      const review = makeReview(context, { reviewId: "review-" + mode });
      const result = await context.engine.processReview(serializeReviewContract(review));
      expect(result.run?.state).toBe("WAITING_APPROVAL");
      expect(context.fake.prompts).toHaveLength(1);
      const approved = await context.engine.approveReview(review.reviewId);
      expect(approved.state).toBe("CODEX_RUNNING");
      expect(context.fake.prompts).toHaveLength(2);
      context.db.close();
    }
  });

  it("blocks failed validation and records the failure", async () => {
    const context = fixture();
    const db = new Database(":memory:");
    const fake = new FakeCodexAdapter();
    const engine = new WorkflowEngine(db, new GitAdapter(), new EventBus(), fake);
    const project = db.createProject({ name: "Failing validation", localPath: context.directory, defaultBranch: "main", workingBranch: "main", testCommand: "node -e \"process.exit(1)\"", autonomyMode: "AUTONOMOUS", reviewMailboxPath: join(context.directory, ".mailbox") });
    const run = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
    await engine.start(run.id, "validation failure"); fake.completeTurn(); await settle(db, run.id);
    expect(db.getRun(run.id)?.state).toBe("BLOCKED");
    expect(db.getValidationResults(run.id).find((item) => item.kind === "test")?.status).toBe("FAIL");
    expect(fake.prompts).toHaveLength(1);
    db.close();
  });

  it("recovery orphans an active turn without resending it", async () => {
    const context = fixture();
    const db = new Database(":memory:");
    const fake = new FakeCodexAdapter();
    const engine = new WorkflowEngine(db, new GitAdapter(), new EventBus(), fake);
    const project = db.createProject({ name: "Recovery", localPath: context.directory, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: "AUTONOMOUS", reviewMailboxPath: join(context.directory, ".mailbox") });
    const run = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
    await engine.start(run.id, "recovery");
    const before = fake.prompts.length;
    const recovered = engine.recover();
    expect(recovered.find((item) => item.id === run.id)?.state).toBe("BLOCKED");
    expect(fake.prompts).toHaveLength(before);
    expect(db.getActiveCodexTurn(run.id)).toBeUndefined();
    db.close();
  });
});
