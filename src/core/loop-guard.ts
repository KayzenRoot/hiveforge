import type { ReviewContract, Run } from "./types";

export interface LoopGuardResult {
  allowed: boolean;
  reason?: string;
  nextIterationCount: number;
  nextCorrectionCycles: number;
  nextRepeatedFindings: Record<string, number>;
}

export function evaluateLoopGuard(run: Run, review: ReviewContract): LoopGuardResult {
  const nextIterationCount = run.iterationCount + 1;
  const nextCorrectionCycles = run.correctionCycles + (review.nextAction === "EXECUTE_CORRECTION" ? 1 : 0);
  const nextRepeatedFindings = { ...run.repeatedFindings };
  for (const finding of review.findings) nextRepeatedFindings[finding.id] = (nextRepeatedFindings[finding.id] ?? 0) + 1;

  if (nextIterationCount > run.maxIterations) {
    return { allowed: false, reason: "maxIterations reached", nextIterationCount, nextCorrectionCycles, nextRepeatedFindings };
  }
  if (nextCorrectionCycles > run.maxCorrectionCycles) {
    return { allowed: false, reason: "maxCorrectionCycles reached", nextIterationCount, nextCorrectionCycles, nextRepeatedFindings };
  }
  const repeated = Object.entries(nextRepeatedFindings).find(([, count]) => count > run.repeatedFindingThreshold);
  if (repeated) {
    return { allowed: false, reason: `repeated finding threshold reached: ${repeated[0]}`, nextIterationCount, nextCorrectionCycles, nextRepeatedFindings };
  }
  return { allowed: true, nextIterationCount, nextCorrectionCycles, nextRepeatedFindings };
}
