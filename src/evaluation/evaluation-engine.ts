import type { EmbeddingProvider } from "../core/interfaces/embedding-provider.js";
import type { StateRepository } from "../core/interfaces/state-repository.js";
import type { VectorStore } from "../core/interfaces/vector-store.js";
import { DecisionEngine } from "../core/engine/decision-engine.js";
import type { DecisionAnswer, DecisionQuestion } from "../core/types/decision.js";
import type { DecisionThresholds } from "../core/types/thresholds.js";
import { DEFAULT_THRESHOLDS } from "../core/types/thresholds.js";

export const EVALUATION_METHODOLOGY = [
  "Evaluation compares the emitted decision with the case label.",
  "Accuracy is the number of correct decisions divided by the total.",
  "The binary positive class is YES. Precision, recall, false positive rate, and false negative rate use only that class.",
  "UNDETERMINED counts as correct only when the label is also UNDETERMINED.",
  "The undetermined rate is the fraction of UNDETERMINED decisions, regardless of the label.",
  "Similarity is not a probability.",
  "Threshold search walks the grid on the provided set. There is no train and validation split, so the chosen threshold is optimistic for that set.",
  "There is no Platt scaling, logistic regression, or conversion of cosine into a probability.",
].join(" ");

export interface ExpectedDecision {
  decision: string;
  selected?: string;
  value?: number;
}

export interface EvaluationCase {
  id: string;
  questions: DecisionQuestion[];
  questionId: string;
  expected: ExpectedDecision;
}

export interface EvaluationCaseResult {
  id: string;
  expected: string;
  actual: string;
  correct: boolean;
}

export interface EvaluationReport {
  methodology: string;
  total: number;
  correct: number;
  accuracy: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  undeterminedRate: number;
  cases: EvaluationCaseResult[];
}

export interface ThresholdGrid {
  minSimilarity?: number[];
  evidenceMargin?: number[];
  contradictionMargin?: number[];
  choiceMargin?: number[];
  choiceEvidenceWeight?: number[];
  relationWeight?: number[];
}

export interface CalibrationReport {
  methodology: string;
  objective: "f1";
  selected: DecisionThresholds;
  selectedMetrics: EvaluationReport;
  evaluated: {
    thresholds: DecisionThresholds;
    accuracy: number;
    f1: number | null;
    undeterminedRate: number;
  }[];
}

export async function evaluateDecisions(
  engine: DecisionEngine,
  stateId: string,
  cases: EvaluationCase[],
): Promise<EvaluationReport> {
  const results: EvaluationCaseResult[] = [];
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  let undetermined = 0;

  for (const item of cases) {
    const response = await engine.decide({ stateId, questions: item.questions });
    const answer = response.answers.find((candidate) => candidate.questionId === item.questionId);
    const actual = answer?.decision ?? "MISSING";
    const correct = matchesExpected(answer, item.expected);
    results.push({ id: item.id, expected: item.expected.decision, actual, correct });
    if (actual === "UNDETERMINED") {
      undetermined += 1;
    }
    const expectedPositive = item.expected.decision === "YES";
    const actualPositive = actual === "YES";
    if (expectedPositive && actualPositive) {
      truePositive += 1;
    } else if (!expectedPositive && actualPositive) {
      falsePositive += 1;
    } else if (expectedPositive && !actualPositive) {
      falseNegative += 1;
    } else {
      trueNegative += 1;
    }
  }

  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  return {
    methodology: EVALUATION_METHODOLOGY,
    total: cases.length,
    correct: results.filter((item) => item.correct).length,
    accuracy: cases.length === 0 ? 0 : results.filter((item) => item.correct).length / cases.length,
    precision,
    recall,
    f1,
    falsePositiveRate: ratio(falsePositive, falsePositive + trueNegative),
    falseNegativeRate: ratio(falseNegative, falseNegative + truePositive),
    undeterminedRate: cases.length === 0 ? 0 : undetermined / cases.length,
    cases: results,
  };
}

export async function calibrateThresholds(options: {
  embeddings: EmbeddingProvider;
  vectors: VectorStore;
  states: StateRepository;
  stateId: string;
  cases: EvaluationCase[];
  base?: Partial<DecisionThresholds>;
  grid?: ThresholdGrid;
}): Promise<CalibrationReport> {
  const base: DecisionThresholds = { ...DEFAULT_THRESHOLDS, ...options.base };
  const points = gridPoints(base, options.grid ?? {});
  const evaluated: CalibrationReport["evaluated"] = [];

  for (const thresholds of points) {
    const engine = new DecisionEngine({
      embeddings: options.embeddings,
      vectors: options.vectors,
      states: options.states,
      thresholds,
    });
    const report = await evaluateDecisions(engine, options.stateId, options.cases);
    evaluated.push({
      thresholds,
      accuracy: report.accuracy,
      f1: report.f1,
      undeterminedRate: report.undeterminedRate,
    });
  }

  const selected = evaluated.slice().sort((left, right) => {
    const f1Delta = (right.f1 ?? -1) - (left.f1 ?? -1);
    if (f1Delta !== 0) {
      return f1Delta;
    }
    if (right.accuracy !== left.accuracy) {
      return right.accuracy - left.accuracy;
    }
    return left.undeterminedRate - right.undeterminedRate;
  })[0];

  if (!selected) {
    throw new Error("The calibration grid produced no point.");
  }

  const selectedEngine = new DecisionEngine({
    embeddings: options.embeddings,
    vectors: options.vectors,
    states: options.states,
    thresholds: selected.thresholds,
  });

  return {
    methodology: EVALUATION_METHODOLOGY,
    objective: "f1",
    selected: selected.thresholds,
    selectedMetrics: await evaluateDecisions(selectedEngine, options.stateId, options.cases),
    evaluated,
  };
}

function matchesExpected(
  answer: DecisionAnswer | undefined,
  expected: ExpectedDecision,
): boolean {
  if (!answer || answer.decision !== expected.decision) {
    return false;
  }
  if (expected.selected !== undefined && (!("selected" in answer) || answer.selected !== expected.selected)) {
    return false;
  }
  if (expected.value !== undefined && (!("value" in answer) || answer.value !== expected.value)) {
    return false;
  }
  return true;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function gridPoints(base: DecisionThresholds, grid: ThresholdGrid): DecisionThresholds[] {
  const axes: Array<[keyof ThresholdGrid, number[]]> = [
    ["minSimilarity", grid.minSimilarity ?? [base.minSimilarity]],
    ["evidenceMargin", grid.evidenceMargin ?? [base.evidenceMargin]],
    ["contradictionMargin", grid.contradictionMargin ?? [base.contradictionMargin]],
    ["choiceMargin", grid.choiceMargin ?? [base.choiceMargin]],
    ["choiceEvidenceWeight", grid.choiceEvidenceWeight ?? [base.choiceEvidenceWeight]],
    ["relationWeight", grid.relationWeight ?? [base.relationWeight]],
  ];
  const points: DecisionThresholds[] = [];
  const walk = (index: number, current: DecisionThresholds) => {
    const axis = axes[index];
    if (!axis) {
      points.push(current);
      return;
    }
    for (const value of axis[1]) {
      walk(index + 1, { ...current, [axis[0]]: value });
    }
  };
  walk(0, base);
  return points;
}
