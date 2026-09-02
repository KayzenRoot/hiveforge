import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCodexAdapter } from "../src/adapters/fake-codex";
import { GitAdapter } from "../src/adapters/git";
import { EventBus } from "../src/core/event-bus";
import { serializeReviewContract } from "../src/core/rcp";
import type { ReviewContract } from "../src/core/types";
import { Database } from "../src/db/database";
import { ReviewMailboxWatcher } from "../src/mailbox/watcher";
import { WorkflowEngine } from "../src/workflow/engine";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "hiveforge-e2e-"));
  git(directory, ["init", "-b", "main"]);
  git(directory, ["config", "user.email", "e2e@hiveforge.local"]);
  git(directory, ["config", "user.name", "HiveForge E2E"]);
  writeFileSync(join(directory, "README.md"), "base\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "base"]);
  return { directory };
}

async function settle(db: Database, runId: string) {
  for (let index = 0; index < 100; index += 1) {
    const state = db.getRun(runId)?.state;
    if (state === "WAITING_REVIEW" || state === "BLOCKED") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("workflow did not settle for run " + runId);
}

async function main() {
  const fixture = createFixture();
  const mailbox = mkdtempSync(join(tmpdir(), "hiveforge-e2e-mailbox-"));
  const db = new Database(":memory:");
  const events = new EventBus();
  const fake = new FakeCodexAdapter();
  const project = db.createProject({ name: "E2E Fixture", localPath: fixture.directory, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: "AUTONOMOUS", reviewMailboxPath: mailbox });
  const engine = new WorkflowEngine(db, new GitAdapter(), events, fake);

  const run = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
  await engine.start(run.id, "first turn");
  fake.completeTurn();
  await settle(db, run.id);
  const waiting = db.getRun(run.id)!;
  assert.equal(waiting.state, "WAITING_REVIEW");
  const evidence = db.getLatestGitEvidence(run.id)!;
  const review: ReviewContract = { schemaVersion: "0.1", reviewId: "review-valid", projectId: project.id, workOrderId: waiting.workOrderId, verdict: "APPROVED", progressPercent: 70, summary: "First increment is valid", findings: [], nextAction: "CONTINUE", executorPrompt: "second turn without copy/paste", checkpointNote: "Continue from the locked evidence", headSha: evidence.headSha, baseSha: evidence.baseSha };
  const watcher = new ReviewMailboxWatcher(mailbox, {
    onReview: async (value) => { const result = await engine.processReview(value); if (value.reviewId === "review-valid") assert.equal(result.accepted, true); else assert.equal(result.accepted, false); },
    onRejected: ({ errors }) => { throw new Error(errors.join("; ")); }
  });
  writeFileSync(join(mailbox, "review-valid.json"), JSON.stringify(serializeReviewContract(review)));
  await watcher.scan();
  assert.equal(fake.prompts.length, 2, "valid review must produce the second dispatch automatically");
  assert.equal(db.getRun(run.id)?.state, "CODEX_RUNNING");

  const negativeRun = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
  await engine.start(negativeRun.id, "negative first turn");
  fake.completeTurn();
  await settle(db, negativeRun.id);
  const negativeWaiting = db.getRun(negativeRun.id)!;
  const negativeEvidence = db.getLatestGitEvidence(negativeRun.id)!;
  const invalidReview: ReviewContract = { ...review, reviewId: "review-wrong-sha", workOrderId: negativeWaiting.workOrderId, headSha: "0000000000000000000000000000000000000000", baseSha: negativeEvidence.baseSha };
  writeFileSync(join(mailbox, "review-wrong-sha.json"), JSON.stringify(serializeReviewContract(invalidReview)));
  await watcher.scan();
  assert.equal(fake.prompts.length, 3, "wrong SHA must not dispatch a second prompt");
  assert.equal(db.getRun(negativeRun.id)?.state, "WAITING_REVIEW");
  watcher.stop();
  db.close();
  console.log("E2E PASS: real terminal callback advanced validation; canonical review dispatched automatically; wrong SHA stayed waiting with no dispatch.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
