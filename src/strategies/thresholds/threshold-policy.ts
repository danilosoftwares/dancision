import type { DecisionThresholds } from "../../core/types/thresholds.js";
import { resolveThresholds } from "../../utils/validation.js";

export function createThresholdPolicy(
  partial?: Partial<DecisionThresholds>,
): DecisionThresholds {
  return resolveThresholds(partial);
}
