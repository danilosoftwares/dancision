import type { DecisionStrategy, StrategyContext } from "../../core/interfaces/decision-strategy.js";
import type { ScoreAnswer, ScoreQuestion, UndeterminedReason } from "../../core/types/decision.js";
import { InvalidDecisionError } from "../../core/errors/index.js";
import { assessEvidence } from "../../evidence/evidence-engine.js";
import { explanationFromAssessment } from "../../evidence/explanation.js";
import { polarityPeaks } from "../../strategies/cosine/cosine-evidence.js";
import { clamp } from "../../utils/vector.js";
import { validateScale } from "../../utils/validation.js";
import { snapToScale } from "./scale.js";

const VERSION = "1.1.0";

export class ScoreStrategy implements DecisionStrategy<ScoreQuestion, ScoreAnswer> {
  readonly type = "score";
  readonly version = VERSION;

  decide(input: StrategyContext<ScoreQuestion>): ScoreAnswer {
    const scale = input.question.scale;
    if (!scale) {
      throw new InvalidDecisionError("Score requires a scale with min, max, and step.");
    }
    validateScale(scale);

    const assessment = assessEvidence({
      knowledge: input.knowledge,
      thresholds: input.thresholds,
      questionPolarity: input.question.polarity ?? "affirmative",
      relations: input.state.relations,
      constraints: input.state.constraints,
      ...(input.question.categories === undefined
        ? {}
        : { questionCategories: input.question.categories }),
    });
    const support = assessment.aggregate.favorable;
    const oppose = assessment.aggregate.contrary;
    const scored = scoreFromAssessment(assessment.verdict, assessment.resolution, support, oppose);
    const value = scored === null ? undefined : snapToScale(scale.min + scored * (scale.max - scale.min), scale);
    const reason = scoreReason(assessment.verdict);
    const result = scored === null ? "UNDETERMINED" : "SCORED";
    const explanation = explanationFromAssessment({
      questionId: input.question.id,
      question: input.question.question,
      state: input.state,
      modelId: input.modelId,
      strategy: { type: this.type, version: this.version },
      thresholds: input.thresholds,
      assessment,
      result,
      ...(reason === undefined ? {} : { reason }),
      extraCalculations: [
        {
          id: "rescale",
          strategy: "margin",
          detail:
            "The value is the winning aggregate, or the gap when margin resolution is active, clamped to [0, 1] and snapped to the scale. It is not a probability.",
          values: {
            support,
            oppose,
            ...(scored === null ? {} : { raw: scored }),
          },
        },
      ],
    });

    return {
      questionId: input.question.id,
      type: "score",
      decision: result,
      similarity: polarityPeaks(input.knowledge),
      evidence: assessment.eligible,
      scale,
      explanation,
      ...(value === undefined ? {} : { value, basis: "rescaled-cosine" as const, support, oppose }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

function scoreFromAssessment(
  verdict: string,
  resolution: string,
  support: number,
  oppose: number,
): number | null {
  if (verdict === "no-evidence" || verdict === "insufficient" || verdict === "contradictory") {
    return null;
  }
  if (verdict === "support") {
    return resolution === "margin" ? clamp(support - oppose, 0, 1) : clamp(support, 0, 1);
  }
  if (verdict === "oppose") {
    return resolution === "margin" ? clamp(support - oppose, 0, 1) : 0;
  }
  return null;
}

function scoreReason(verdict: string): UndeterminedReason | undefined {
  if (verdict === "no-evidence") {
    return "NO_EVIDENCE";
  }
  if (verdict === "insufficient") {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (verdict === "contradictory") {
    return "CONTRADICTORY";
  }
  return undefined;
}
