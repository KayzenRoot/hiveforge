import type { GitEvidence, Project, ReviewContract, Run } from "./types";

export interface EvidenceLockResult {
  locked: boolean;
  errors: string[];
}

export function verifyEvidenceLock(review: ReviewContract, project: Project, run: Run, evidence: GitEvidence): EvidenceLockResult {
  const errors: string[] = [];
  if (review.project_id !== project.id) errors.push("project_id mismatch");
  if (review.run_id !== run.id) errors.push("run_id mismatch");
  if (review.work_order_id !== run.workOrderId) errors.push("work_order_id mismatch");
  if (review.head_sha !== evidence.headSha) errors.push("head_sha does not match captured Git evidence");
  if (review.base_sha !== evidence.baseSha) errors.push("base_sha does not match captured Git evidence");
  return { locked: errors.length === 0, errors };
}
