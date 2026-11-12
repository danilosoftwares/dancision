import type { DecisionThresholds } from "../../core/types/thresholds.js";

export const MARGIN_VERSION = "1.0.0";

export type MarginVerdict = "support" | "oppose" | "contradictory" | "insufficient";

export function judgeMargin(
  support: number,
  oppose: number,
  supportCount: number,
  opposeCount: number,
  thresholds: DecisionThresholds,
): MarginVerdict {
  if (supportCount === 0 && opposeCount === 0) {
    return "insufficient";
  }
  const both = supportCount > 0 && opposeCount > 0;
  const gap = Math.abs(support - oppose);
  if (both && gap < thresholds.contradictionMargin) {
    return "contradictory";
  }
  if (supportCount > 0 && support - oppose >= thresholds.evidenceMargin) {
    return "support";
  }
  if (opposeCount > 0 && oppose - support >= thresholds.evidenceMargin) {
    return "oppose";
  }
  return "insufficient";
}
