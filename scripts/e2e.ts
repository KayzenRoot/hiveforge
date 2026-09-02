import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCodexAdapter } from "../src/adapters/fake-codex";
import { GitAdapter } from "../src/adapters/git";
import { EventBus } from "../src/core/event-bus";
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
  writeFileSync(join(directory, "README.md"), "head\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "head"]);
  return { directory, headSha: git(directory, ["rev-parse", "HEAD"]) };
}

async function main() {
  const fixture = createFixture();
  const mailbox = join(fixture.directory, ".mailbox");
  mkdirSync(mailbox);
  const db = new Database(":memory:");
  const events = new EventBus();
  const fake = new FakeCodexAdapter();
  const project = db.createProject({ name: "E2E Fixture", localPath: fixture.directory, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: "AUTONOMOUS", reviewMailboxPath: mailbox });
  const engine = new WorkflowEngine(db, new GitAdapter(), events, fake);

  const run = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
  await engine.start(run.id, "first turn");
  await engine.markValidation(run.id);
  const waiting = db.getRun(run.id)!;
  assert.equal(waiting.state, "WAITING_REVIEW");
  const evidence = db.getLatestGitEvidence(run.id)!;
  const review: ReviewContract = { protocol: "RCP", version: "0.1", review_id: "review-valid", project_id: project.id, run_id: run.id, work_order_id: waiting.workOrderId, decision: "APPROVED", action: "CONTINUE", head_sha: evidence.headSha, base_sha: evidence.baseSha, findings: [], executor_prompt: "second turn without copy/paste", created_at: new Date().toISOString() };
  const watcher = new ReviewMailboxWatcher(mailbox, { onReview: async (value) => { const result = await engine.processReview(value); if (value.review_id === "review-valid") assert.equal(result.accepted, true); else assert.equal(result.accepted, false); }, onRejected: ({ errors }) => { throw new Error(errors.join("; ")); } });
  writeFileSync(join(mailbox, "review-valid.json"), JSON.stringify(review));
  await watcher.scan();
  assert.equal(fake.prompts.length, 2, "valid review must produce the second dispatch automatically");
  assert.equal(db.getRun(run.id)?.state, "CODEX_RUNNING");

  const negativeRun = db.createRun({ projectId: project.id, autonomyMode: "AUTONOMOUS" });
  await engine.start(negativeRun.id, "negative first turn");
  await engine.markValidation(negativeRun.id);
  const negativeWaiting = db.getRun(negativeRun.id)!;
  const negativeEvidence = db.getLatestGitEvidence(negativeRun.id)!;
  const invalidReview = { ...review, review_id: "review-wrong-sha", run_id: negativeRun.id, work_order_id: negativeWaiting.workOrderId, head_sha: "0000000000000000000000000000000000000000", base_sha: negativeEvidence.baseSha };
  writeFileSync(join(mailbox, "review-wrong-sha.json"), JSON.stringify(invalidReview));
  await watcher.scan();
  assert.equal(fake.prompts.length, 3, "wrong SHA must not dispatch a second prompt");
  assert.equal(db.getRun(negativeRun.id)?.state, "WAITING_REVIEW");
  watcher.stop();
  db.close();
  console.log("E2E PASS: valid review dispatched automatically; wrong SHA stayed waiting with no dispatch.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
