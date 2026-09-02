import { describe, expect, it } from "vitest";
import { verifyEvidenceLock } from "../src/core/evidence-lock";
import { evaluateLoopGuard } from "../src/core/loop-guard";
import { validateReviewContract } from "../src/core/rcp";
import { allowedTransitions, canTransition, transition } from "../src/core/state-machine";
import type { GitEvidence, Project, ReviewContract, Run } from "../src/core/types";

const project: Project = { id: "project-1", name: "Test", localPath: "C:/repo", defaultBranch: "main", workingBranch: "main", testCommand: "npm test", autonomyMode: "AUTONOMOUS", reviewMailboxPath: "C:/mailbox", createdAt: "now", updatedAt: "now" };
const run: Run = { id: "run-1", projectId: project.id, workOrderId: "WO-123", state: "WAITING_REVIEW", autonomyMode: "AUTONOMOUS", maxIterations: 3, maxCorrectionCycles: 2, repeatedFindingThreshold: 2, iterationCount: 1, correctionCycles: 0, repeatedFindings: {}, currentPrompt: "first", expectedBaseSha: "base", expectedHeadSha: "head", lastReviewId: null, createdAt: "now", updatedAt: "now" };
const evidence: GitEvidence = { id: "evidence-1", runId: run.id, baseSha: "base", headSha: "head", branch: "main", status: "clean", changedFiles: [], diffSummary: "", capturedAt: "now" };

function review(overrides: Partial<ReviewContract> = {}): ReviewContract {
  return { protocol: "RCP", version: "0.1", review_id: "review-1", project_id: project.id, run_id: run.id, work_order_id: run.workOrderId, decision: "APPROVED", action: "CONTINUE", head_sha: "head", base_sha: "base", findings: [], executor_prompt: "next", created_at: "now", ...overrides };
}

describe("workflow state machine", () => {
  it("allows only explicit transitions", () => {
    expect(canTransition("IDLE", "QUEUED")).toBe(true);
    expect(canTransition("IDLE", "COMPLETE")).toBe(false);
    expect(transition("IDLE", "QUEUED")).toBe("QUEUED");
    expect(() => transition("IDLE", "COMPLETE")).toThrow("Invalid run transition");
    expect(allowedTransitions("WAITING_REVIEW")).toContain("REVIEW_RECEIVED");
  });
});

describe("RCP v0.1", () => {
  it("accepts a complete contract", () => {
    const result = validateReviewContract(review());
    expect(result.valid).toBe(true);
    expect(result.value?.action).toBe("CONTINUE");
  });

  it("rejects missing critical fields and mismatched actions", () => {
    const result = validateReviewContract({ ...review(), head_sha: "", action: "EXECUTE_CORRECTION" });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(["head_sha must be a non-empty string", "APPROVED requires CONTINUE"]));
  });
});

describe("evidence lock and loop guards", () => {
  it("locks matching project, work order and SHAs", () => {
    expect(verifyEvidenceLock(review(), project, run, evidence).locked).toBe(true);
    expect(verifyEvidenceLock(review({ head_sha: "wrong" }), project, run, evidence).locked).toBe(false);
  });

  it("blocks max iterations, correction cycles and repeated findings", () => {
    expect(evaluateLoopGuard({ ...run, iterationCount: 3 }, review()).allowed).toBe(false);
    expect(evaluateLoopGuard({ ...run, correctionCycles: 2 }, review({ decision: "CORRECTION_REQUIRED", action: "EXECUTE_CORRECTION" })).allowed).toBe(false);
    expect(evaluateLoopGuard({ ...run, repeatedFindings: { F1: 2 } }, review({ findings: [{ id: "F1", severity: "HIGH", summary: "still present" }] })).allowed).toBe(false);
  });
});
