import type { ScoredKnowledge } from "../../core/interfaces/vector-store.js";
import type { DecisionStrategy, StrategyContext } from "../../core/interfaces/decision-strategy.js";
import type {
  ChoiceAlternative,
  ChoiceAnswer,
  ChoiceQuestion,
  QuestionPolarity,
  UndeterminedReason,
} from "../../core/types/decision.js";
import { InvalidDecisionError } from "../../core/errors/index.js";
import { assessEvidence } from "../../evidence/evidence-engine.js";
import { explanationFromAssessment } from "../../evidence/explanation.js";

const VERSION = "1.1.0";

export class ChoiceStrategy implements DecisionStrategy<ChoiceQuestion, ChoiceAnswer> {
  readonly type = "choice";
  readonly version = VERSION;

  decide(input: StrategyContext<ChoiceQuestion>): ChoiceAnswer {
    const options = input.question.options;
    if (!options || options.length === 0) {
      throw new InvalidDecisionError("Choice requires at least one option.");
    }

    const questionPolarity = input.question.polarity ?? "affirmative";
    const assessment = assessEvidence({
      knowledge: input.knowledge,
      thresholds: input.thresholds,
      questionPolarity,
      relations: input.state.relations,
      constraints: input.state.constraints,
      ...(input.question.categories === undefined
        ? {}
        : { questionCategories: input.question.categories }),
    });
    const eligibleIds = new Set(assessment.eligible.map((item) => item.knowledgeId));
    const eligibleKnowledge = input.knowledge.filter((item) => eligibleIds.has(item.knowledgeId));
    const alternatives = options.map((option) => {
      const optionVector = input.optionVectors.get(option.id);
      if (!optionVector) {
        throw new InvalidDecisionError(`Missing embedding for option ${option.id}.`);
      }
      const similarity = input.similarity.compare(input.questionVector, optionVector);
      const evidenceScore = optionEvidenceScore(
        optionVector,
        eligibleKnowledge,
        questionPolarity,
        input.similarity.compare,
      );
      return {
        id: option.id,
        similarity,
        evidenceScore,
        rankingScore: similarity + input.thresholds.choiceEvidenceWeight * evidenceScore,
      };
    });
    const outcome = chooseAlternative(alternatives, assessment.verdict, input.thresholds.choiceMargin, input.thresholds.minSimilarity);
    const explanation = explanationFromAssessment({
      questionId: input.question.id,
      question: input.question.question,
      state: input.state,
      modelId: input.modelId,
      strategy: { type: this.type, version: this.version },
      thresholds: input.thresholds,
      assessment,
      result: outcome.decision,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      extraCalculations: alternatives.map((alternative) => ({
        id: `option-${alternative.id}`,
        strategy: "weighted",
        detail: "rankingScore = option similarity + weight * aggregated evidence.",
        values: {
          similarity: alternative.similarity,
          evidenceScore: alternative.evidenceScore,
          rankingScore: alternative.rankingScore,
        },
      })),
      extraCriteria: [
        {
          name: "option close to the question",
          passed: outcome.reason !== "WEAK_MATCH" && outcome.reason !== "CONTRADICTORY",
          detail: "The winning option must pass minSimilarity. An unresolved conflict blocks the selection.",
        },
        {
          name: "margin between options",
          passed: outcome.reason !== "AMBIGUOUS",
          detail: `The minimum gap between options is ${input.thresholds.choiceMargin}.`,
        },
      ],
    });

    return {
      questionId: input.question.id,
      type: "choice",
      decision: outcome.decision,
      alternatives,
      evidence: assessment.eligible,
      explanation,
      ...(outcome.selected === undefined ? {} : { selected: outcome.selected }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    };
  }
}

function chooseAlternative(
  alternatives: ChoiceAlternative[],
  verdict: string,
  choiceMargin: number,
  minSimilarity: number,
): { decision: ChoiceAnswer["decision"]; selected?: string; reason?: UndeterminedReason } {
  if (verdict === "contradictory") {
    return { decision: "UNDETERMINED", reason: "CONTRADICTORY" };
  }
  const ranked = alternatives
    .map((alternative, index) => ({ alternative, index }))
    .sort(
      (left, right) =>
        right.alternative.rankingScore - left.alternative.rankingScore ||
        left.index - right.index,
    );
  const best = ranked[0]?.alternative;
  const second = ranked[1]?.alternative;
  if (!best) {
    throw new InvalidDecisionError("Choice requires at least one option.");
  }
  const gap =
    second === undefined
      ? Number.POSITIVE_INFINITY
      : best.rankingScore - second.rankingScore;
  if (best.similarity < minSimilarity) {
    return { decision: "UNDETERMINED", reason: "WEAK_MATCH" };
  }
  if (gap < choiceMargin) {
    return { decision: "UNDETERMINED", reason: "AMBIGUOUS" };
  }
  return { decision: "SELECTED", selected: best.id };
}

function optionEvidenceScore(
  optionVector: number[],
  eligible: ScoredKnowledge[],
  questionPolarity: QuestionPolarity,
  compare: (left: number[], right: number[]) => number,
): number {
  if (eligible.length === 0) {
    return 0;
  }
  let total = 0;
  for (const item of eligible) {
    let sign = item.polarity === "positive" ? 1 : -1;
    if (questionPolarity === "negative") {
      sign *= -1;
    }
    total += compare(optionVector, item.vector) * sign * (item.weight ?? 1);
  }
  return total / eligible.length;
}
