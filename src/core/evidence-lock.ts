import type { GitEvidence, Project, ReviewContract, Run } from "./types";

export interface EvidenceLockResult {
  locked: boolean;
  errors: string[];
}

export function verifyEvidenceLock(review: ReviewContract, project: Project, run: Run, evidence: GitEvidence): EvidenceLockResult {
  const errors: string[] = [];
  if (review.projectId !== project.id) errors.push("project_id mismatch");
  if (review.workOrderId !== run.workOrderId) errors.push("work_order_id mismatch");
  if (review.headSha !== evidence.headSha) errors.push("head_sha does not match captured Git evidence");
  if (review.baseSha !== evidence.baseSha) errors.push("base_sha does not match captured Git evidence");
  if (run.expectedHeadSha !== evidence.headSha) errors.push("stored run head SHA does not match captured Git evidence");
  if (run.expectedBaseSha !== evidence.baseSha) errors.push("stored run base SHA does not match captured Git evidence");
  if (!evidence.isClean) errors.push("working tree is not clean");
  return { locked: errors.length === 0, errors };
}
