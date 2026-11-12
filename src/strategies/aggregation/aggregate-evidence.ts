import type { AggregationMethod } from "../../core/types/thresholds.js";

export const AGGREGATION_VERSION = "1.0.0";

export function aggregateEvidence(
  values: number[],
  method: AggregationMethod,
): number {
  if (values.length === 0) {
    return 0;
  }
  if (method === "peak") {
    return Math.max(...values);
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (method === "mean") {
    return total / values.length;
  }
  return total;
}
