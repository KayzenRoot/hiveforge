import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MailboxWatcherRegistry } from "../src/mailbox/registry";
import type { Project } from "../src/core/types";

function project(id: string, mailboxPath: string): Project {
  return { id, name: id, localPath: mailboxPath, defaultBranch: "main", workingBranch: "main", testCommand: "node --version", autonomyMode: "AUTONOMOUS", reviewMailboxPath: mailboxPath, createdAt: "now", updatedAt: "now" };
}

describe("dynamic mailbox watcher registry", () => {
  it("reconciles projects created after worker startup without duplicate watchers", async () => {
    const firstPath = mkdtempSync(join(tmpdir(), "hiveforge-mailbox-"));
    const secondPath = mkdtempSync(join(tmpdir(), "hiveforge-mailbox-"));
    const seen: string[] = [];
    const registry = new MailboxWatcherRegistry((item) => ({
      onReview: (review) => { seen.push(item.id + ":" + review.reviewId); },
      onRejected: () => { throw new Error("unexpected rejection"); }
    }));
    const first = project("first", firstPath);
    const second = project("second", secondPath);
    await registry.reconcile([first]);
    expect(registry.size).toBe(1);
    await registry.reconcile([first, second]);
    expect(registry.size).toBe(2);
    await registry.reconcile([first, second]);
    expect(registry.size).toBe(2);
    writeFileSync(join(secondPath, "review.json"), JSON.stringify({
      schema_version: "0.1", review_id: "dynamic-review", project_id: "second", work_order_id: "WO-DYNAMIC",
      base_sha: "0123456789abcdef0123456789abcdef01234567", head_sha: "fedcba9876543210fedcba9876543210fedcba98",
      verdict: "BLOCKED", progress_percent: 0, summary: "waiting", findings: [], next_action: "WAIT",
      executor_prompt: "wait", checkpoint_note: "wait"
    }));
    await registry.scanAll();
    expect(seen).toEqual(["second:dynamic-review"]);
    registry.stopAll();
  });
});
