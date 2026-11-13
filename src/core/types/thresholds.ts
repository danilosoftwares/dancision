export type AggregationMethod = "sum" | "mean" | "peak";

export type ConflictResolution = "priority" | "margin";

export interface DecisionThresholds {
  minSimilarity: number;
  evidenceMargin: number;
  contradictionMargin: number;
  choiceMargin: number;
  topK: number;
  positiveTopK?: number;
  negativeTopK?: number;
  neutralTopK?: number;
  choiceEvidenceWeight: number;
  aggregation: AggregationMethod;
  conflictResolution: ConflictResolution;
  relationWeight: number;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = Object.freeze({
  minSimilarity: 0.72,
  evidenceMargin: 0.05,
  contradictionMargin: 0.05,
  choiceMargin: 0.04,
  topK: 8,
  choiceEvidenceWeight: 0.15,
  aggregation: "sum",
  conflictResolution: "priority",
  relationWeight: 0,
});
