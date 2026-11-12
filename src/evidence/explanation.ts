import type {
  CalculationStep,
  DecisionCriterion,
  DecisionExplanation,
} from "../core/types/decision.js";
import type { DecisionStateContext } from "../core/types/state.js";
import type { DecisionThresholds } from "../core/types/thresholds.js";
import type { EvidenceAssessment } from "./evidence-engine.js";

export function explanationFromAssessment(input: {
  questionId: string;
  question: string;
  state: DecisionStateContext;
  modelId: string;
  strategy: { type: string; version: string };
  thresholds: DecisionThresholds;
  assessment: EvidenceAssessment;
  result: string;
  reason?: string;
  extraCalculations?: CalculationStep[];
  extraCriteria?: DecisionCriterion[];
}): DecisionExplanation {
  return {
    questionId: input.questionId,
    question: input.question,
    stateId: input.state.id,
    stateVersion: input.state.version,
    modelId: input.modelId,
    strategy: input.strategy,
    thresholds: input.thresholds,
    retrieved: input.assessment.retrieved,
    favorable: input.assessment.favorable,
    contrary: input.assessment.contrary,
    conflicts: input.assessment.conflicts,
    calculations: [
      ...input.assessment.calculations,
      ...(input.extraCalculations ?? []),
    ],
    criteria: [...input.assessment.criteria, ...(input.extraCriteria ?? [])],
    result: input.result,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}
