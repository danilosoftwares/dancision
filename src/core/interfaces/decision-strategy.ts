import type { ScoredKnowledge } from "./vector-store.js";
import type { DecisionStateContext } from "../types/state.js";
import type { SimilarityMeasure } from "../../strategies/similarity/similarity-measure.js";
import type {
  DecisionAnswerBase,
  DecisionQuestionBase,
  DecisionThresholds,
} from "../types/index.js";

export interface StrategyContext<
  TQuestion extends DecisionQuestionBase = DecisionQuestionBase,
> {
  question: TQuestion;
  questionVector: number[];
  knowledge: ScoredKnowledge[];
  optionVectors: ReadonlyMap<string, number[]>;
  thresholds: DecisionThresholds;
  state: DecisionStateContext;
  modelId: string;
  similarity: SimilarityMeasure;
}

export type StrategyDecision<TAnswer extends DecisionAnswerBase = DecisionAnswerBase> = Omit<
  TAnswer,
  "explanation"
> & {
  explanation?: TAnswer["explanation"];
};

export interface DecisionStrategy<
  TQuestion extends DecisionQuestionBase = DecisionQuestionBase,
  TAnswer extends DecisionAnswerBase = DecisionAnswerBase,
> {
  readonly type: string;
  readonly version: string;
  decide(input: StrategyContext<TQuestion>): StrategyDecision<TAnswer>;
}
