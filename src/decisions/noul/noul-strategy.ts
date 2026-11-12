import type { DecisionStrategy, StrategyContext } from "../../core/interfaces/decision-strategy.js";
import type { NoulAnswer, NoulQuestion, UndeterminedReason } from "../../core/types/decision.js";
import { assessEvidence } from "../../evidence/evidence-engine.js";
import { explanationFromAssessment } from "../../evidence/explanation.js";
import { polarityPeaks } from "../../strategies/cosine/cosine-evidence.js";

const VERSION = "1.1.0";

export class NoulStrategy implements DecisionStrategy<NoulQuestion, NoulAnswer> {
  readonly type = "noul";
  readonly version = VERSION;

  decide(input: StrategyContext<NoulQuestion>): NoulAnswer {
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
    const outcome = noulOutcome(assessment.verdict);
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
    });
    return {
      questionId: input.question.id,
      type: "noul",
      decision: outcome.decision,
      similarity: polarityPeaks(input.knowledge),
      evidence: assessment.eligible,
      explanation,
      ...(outcome.value === undefined ? {} : { value: outcome.value }),
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    };
  }
}

function noulOutcome(verdict: string): {
  decision: NoulAnswer["decision"];
  value?: boolean;
  reason?: UndeterminedReason;
} {
  switch (verdict) {
    case "support":
      return { decision: "YES", value: true };
    case "oppose":
      return { decision: "NO", value: false };
    case "no-evidence":
      return { decision: "UNDETERMINED", reason: "NO_EVIDENCE" };
    case "contradictory":
      return { decision: "UNDETERMINED", reason: "CONTRADICTORY" };
    default:
      return { decision: "UNDETERMINED", reason: "INSUFFICIENT_EVIDENCE" };
  }
}
