import type { Polarity } from "./knowledge.js";
import type { DecisionThresholds } from "./thresholds.js";

export type QuestionPolarity = "affirmative" | "negative";

export type UndeterminedReason =
  | "NO_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "CONTRADICTORY"
  | "AMBIGUOUS"
  | "WEAK_MATCH"
  | "CONDITION_NOT_MET";

export interface QuestionCondition {
  questionId: string;
  decisions: string[];
}

export interface DecisionQuestionBase {
  id: string;
  type: string;
  question: string;
  polarity?: QuestionPolarity;
  categories?: string[];
  when?: QuestionCondition;
}

export interface NoulQuestion extends DecisionQuestionBase {
  type: "noul";
}

export interface ChoiceOption {
  id: string;
  description: string;
}

export interface ChoiceQuestion extends DecisionQuestionBase {
  type: "choice";
  options: ChoiceOption[];
}

export interface ScoreScale {
  min: number;
  max: number;
  step: number;
}

export interface ScoreQuestion extends DecisionQuestionBase {
  type: "score";
  scale: ScoreScale;
}

export type DecisionQuestion =
  | NoulQuestion
  | ChoiceQuestion
  | ScoreQuestion
  | DecisionQuestionBase;

export interface DecideRequest {
  stateId: string;
  questions: DecisionQuestion[];
}

export interface EvidenceItem {
  knowledgeId: string;
  content: string;
  similarity: number;
  polarity: Polarity;
  relevance: number;
  weight: number;
  priority: number;
  side: "favorable" | "contrary" | "neutral";
  source?: string;
  categories?: string[];
}

export interface EvidenceConflict {
  knowledgeIds: string[];
  level: number;
  reason: "polarity" | "relation";
  resolved: boolean;
  resolution?: "priority" | "source" | "margin";
  keptId?: string;
  relationId?: string;
}

export interface CalculationStep {
  id: string;
  strategy: string;
  detail: string;
  values: Record<string, number | string>;
}

export interface DecisionCriterion {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DecisionExplanation {
  questionId: string;
  question: string;
  stateId: string;
  stateVersion: number;
  modelId: string;
  strategy: { type: string; version: string };
  thresholds: DecisionThresholds;
  retrieved: EvidenceItem[];
  favorable: EvidenceItem[];
  contrary: EvidenceItem[];
  conflicts: EvidenceConflict[];
  calculations: CalculationStep[];
  criteria: DecisionCriterion[];
  result: string;
  reason?: string;
}

export interface SimilarityBreakdown {
  positive: number;
  negative: number;
}

export interface DecisionAnswerBase {
  questionId: string;
  type: string;
  decision: string;
  reason?: UndeterminedReason | string;
  evidence: EvidenceItem[];
  explanation: DecisionExplanation;
}

export interface NoulAnswer extends DecisionAnswerBase {
  type: "noul";
  decision: "YES" | "NO" | "UNDETERMINED";
  value?: boolean;
  reason?: UndeterminedReason;
  similarity: SimilarityBreakdown;
  evidence: EvidenceItem[];
}

export interface ChoiceAlternative {
  id: string;
  similarity: number;
  rankingScore: number;
  evidenceScore: number;
}

export interface ChoiceAnswer extends DecisionAnswerBase {
  type: "choice";
  decision: "SELECTED" | "UNDETERMINED";
  selected?: string;
  reason?: UndeterminedReason;
  alternatives: ChoiceAlternative[];
  evidence: EvidenceItem[];
}

export interface ScoreAnswer extends DecisionAnswerBase {
  type: "score";
  decision: "SCORED" | "UNDETERMINED";
  value?: number;
  reason?: UndeterminedReason;
  basis?: "rescaled-cosine";
  support?: number;
  oppose?: number;
  similarity: SimilarityBreakdown;
  evidence: EvidenceItem[];
  scale: ScoreScale;
}

export type DecisionAnswer =
  | NoulAnswer
  | ChoiceAnswer
  | ScoreAnswer
  | DecisionAnswerBase;

export interface DecideResponse {
  stateId: string;
  answers: DecisionAnswer[];
}
