import { describe, expect, it } from "vitest";
import { verifyEvidenceLock } from "../src/core/evidence-lock";
import { evaluateLoopGuard } from "../src/core/loop-guard";
import { validateReviewContract, serializeReviewContract } from "../src/core/rcp";
import { allowedTransitions, canTransition, transition } from "../src/core/state-machine";
import type { GitEvidence, Project, ReviewContract, Run } from "../src/core/types";

const shaBase = "0123456789abcdef0123456789abcdef01234567";
const shaHead = "fedcba9876543210fedcba9876543210fedcba98";
const project: Project = { id: "project-1", name: "Test", localPath: "C:/repo", defaultBranch: "main", workingBranch: "main", testCommand: "npm test", autonomyMode: "AUTONOMOUS", reviewMailboxPath: "C:/mailbox", createdAt: "now", updatedAt: "now" };
const run: Run = { id: "run-1", projectId: project.id, workOrderId: "WO-123", state: "WAITING_REVIEW", autonomyMode: "AUTONOMOUS", maxIterations: 3, maxCorrectionCycles: 2, repeatedFindingThreshold: 2, iterationCount: 1, correctionCycles: 0, repeatedFindings: {}, currentPrompt: "first", runBaseSha: shaBase, runBaseBranch: "main", expectedBaseSha: shaBase, expectedHeadSha: shaHead, lastReviewId: null, lastReviewStatus: null, lastReviewVerdict: null, lastReviewSummary: null, lastCheckpointNote: null, progressPercent: 0, currentBlocker: null, createdAt: "now", updatedAt: "now" };
const evidence: GitEvidence = { id: "evidence-1", runId: run.id, baseSha: shaBase, headSha: shaHead, branch: "main", status: "clean", changedFiles: [], diffSummary: "", isClean: true, capturedAt: "now" };

function review(overrides: Partial<ReviewContract> = {}): ReviewContract {
  return { schemaVersion: "0.1", reviewId: "review-1", projectId: project.id, workOrderId: run.workOrderId, baseSha: shaBase, headSha: shaHead, verdict: "APPROVED", progressPercent: 50, summary: "Increment reviewed", findings: [], nextAction: "CONTINUE", executorPrompt: "next", checkpointNote: "Evidence locked", ...overrides };
}

function canonical(overrides: Record<string, unknown> = {}) {
  return { ...serializeReviewContract(review()), ...overrides };
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

describe("canonical RCP v0.1", () => {
  it("accepts and serializes the exact external contract", () => {
    const result = validateReviewContract(canonical());
    expect(result.valid).toBe(true);
    expect(result.value?.nextAction).toBe("CONTINUE");
    expect(serializeReviewContract(result.value!)).toEqual(canonical());
  });

  it("rejects legacy aliases and incomplete evidence fields", () => {
    const result = validateReviewContract({ ...canonical(), protocol: "RCP", run_id: run.id, head_sha: "", findings: [{ id: "F1", severity: "HIGH" }] });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(["protocol is not part of canonical RCP v0.1", "run_id is not part of canonical RCP v0.1", "head_sha must be a non-empty string", "findings[0].title must be a non-empty string", "findings[0].details must be a non-empty string"]));
  });

  it("enforces verdict and next_action coherence", () => {
    const result = validateReviewContract(canonical({ verdict: "APPROVED", next_action: "EXECUTE_CORRECTION" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("APPROVED requires next_action CONTINUE");
  });
});

describe("evidence lock and loop guards", () => {
  it("locks matching project, work order, base/head SHAs and clean state", () => {
    expect(verifyEvidenceLock(review(), project, run, evidence).locked).toBe(true);
    expect(verifyEvidenceLock(review({ headSha: shaBase }), project, run, evidence).locked).toBe(false);
    expect(verifyEvidenceLock(review(), project, run, { ...evidence, isClean: false }).locked).toBe(false);
  });

  it("blocks max iterations, correction cycles and repeated findings", () => {
    expect(evaluateLoopGuard({ ...run, iterationCount: 3 }, review()).allowed).toBe(false);
    expect(evaluateLoopGuard({ ...run, correctionCycles: 2 }, review({ verdict: "CORRECTION_REQUIRED", nextAction: "EXECUTE_CORRECTION" })).allowed).toBe(false);
    expect(evaluateLoopGuard({ ...run, repeatedFindings: { F1: 2 } }, review({ findings: [{ id: "F1", severity: "HIGH", title: "Still present", details: "Still present" }] })).allowed).toBe(false);
  });
});
