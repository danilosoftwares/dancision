import type { ScoredKnowledge } from "../core/interfaces/vector-store.js";
import type {
  CalculationStep,
  DecisionCriterion,
  EvidenceConflict,
  EvidenceItem,
  QuestionPolarity,
} from "../core/types/decision.js";
import type { KnowledgeRelation, StateConstraint } from "../core/types/state.js";
import type { AggregationMethod, DecisionThresholds } from "../core/types/thresholds.js";
import { aggregateEvidence } from "../strategies/aggregation/aggregate-evidence.js";
import { judgeMargin } from "../strategies/margin/margin-rule.js";
import { polaritySide, type EvidenceSide } from "../strategies/polarity/polarity-split.js";
import {
  applicableConstraints,
  bestSourceRank,
} from "../strategies/rules/constraint-rules.js";
import { weightedRelevance } from "../strategies/weighted/weighted-relevance.js";

export const EVIDENCE_ENGINE_VERSION = "1.0.0";
export const HYBRID_VERSION = "1.0.0";

export type EvidenceVerdictKind =
  | "no-evidence"
  | "insufficient"
  | "contradictory"
  | "support"
  | "oppose";

export type ConflictResolutionApplied =
  | "none"
  | "priority"
  | "source"
  | "margin"
  | "unresolved";

export interface EvidenceAssessment {
  retrieved: EvidenceItem[];
  eligible: EvidenceItem[];
  favorable: EvidenceItem[];
  contrary: EvidenceItem[];
  conflicts: EvidenceConflict[];
  aggregate: {
    favorable: number;
    contrary: number;
    method: AggregationMethod;
  };
  resolution: ConflictResolutionApplied;
  verdict: EvidenceVerdictKind;
  calculations: CalculationStep[];
  criteria: DecisionCriterion[];
}

export interface AssessEvidenceInput {
  knowledge: ScoredKnowledge[];
  thresholds: DecisionThresholds;
  questionPolarity: QuestionPolarity;
  relations?: KnowledgeRelation[];
  constraints?: StateConstraint[];
  questionCategories?: string[];
}

interface MutableEvidence {
  evidence: EvidenceItem;
  eligible: boolean;
}

interface ItemChoice {
  by: "priority" | "source";
  item: MutableEvidence;
  loser: MutableEvidence;
}

interface SideChoice {
  by: "priority" | "source";
  side: EvidenceSide;
  keptId: string;
}

export function assessEvidence(input: AssessEvidenceInput): EvidenceAssessment {
  const thresholds = input.thresholds;
  const relations = input.relations ?? [];
  const questionCategories = input.questionCategories ?? [];
  const constraints = applicableConstraints(input.constraints ?? [], questionCategories);
  const priorityFloor = constraints
    .filter((constraint) => constraint.kind === "minimum-priority")
    .reduce(
      (highest, constraint) => Math.max(highest, constraint.minimumPriority ?? Number.NEGATIVE_INFINITY),
      Number.NEGATIVE_INFINITY,
    );
  const sourcePreference = constraints
    .filter((constraint) => constraint.kind === "prefer-source")
    .flatMap((constraint) => constraint.sources ?? []);
  const minEvidence = constraints
    .filter((constraint) => constraint.kind === "minimum-evidence")
    .reduce((highest, constraint) => Math.max(highest, constraint.minEvidence ?? 1), 0);

  const mutable = input.knowledge.map((item) =>
    toMutable(item, input.questionPolarity, questionCategories, priorityFloor, thresholds.minSimilarity),
  );
  applySupportBoost(mutable, relations, thresholds.relationWeight);

  const conflicts: EvidenceConflict[] = [];
  let resolution: ConflictResolutionApplied = "none";
  let unresolved = false;

  for (const relation of relations) {
    if (relation.type !== "contradicts") {
      continue;
    }
    const left = findEligible(mutable, relation.from);
    const right = findEligible(mutable, relation.to);
    if (!left || !right) {
      continue;
    }
    const kept = chooseItem(left, right, sourcePreference);
    conflicts.push({
      knowledgeIds: [left.evidence.knowledgeId, right.evidence.knowledgeId],
      level: Math.abs(left.evidence.relevance - right.evidence.relevance),
      reason: "relation",
      resolved: kept !== null,
      ...(kept === null
        ? {}
        : { resolution: kept.by, keptId: kept.item.evidence.knowledgeId, relationId: relation.id }),
      ...(kept === null ? { relationId: relation.id } : {}),
    });
    if (!kept) {
      unresolved = true;
      continue;
    }
    kept.loser.eligible = false;
    resolution = kept.by;
  }

  if (bothSides(mutable)) {
    const favorableNow = eligibleOnSide(mutable, "favorable");
    const contraryNow = eligibleOnSide(mutable, "contrary");
    const keptSide = chooseSide(favorableNow, contraryNow, sourcePreference);
    const level = Math.abs(sumRelevance(favorableNow) - sumRelevance(contraryNow));
    const ids = [...favorableNow, ...contraryNow].map((item) => item.knowledgeId);
    if (keptSide) {
      const loser = keptSide.side === "favorable" ? contraryNow : favorableNow;
      for (const item of loser) {
        const target = findEligible(mutable, item.knowledgeId);
        if (target) {
          target.eligible = false;
        }
      }
      conflicts.push({
        knowledgeIds: ids,
        level,
        reason: "polarity",
        resolved: true,
        resolution: keptSide.by,
        keptId: keptSide.keptId,
      });
      resolution = keptSide.by;
    } else if (thresholds.conflictResolution === "margin") {
      const judged = judgeMargin(
        aggregateSide(favorableNow, thresholds.aggregation),
        aggregateSide(contraryNow, thresholds.aggregation),
        favorableNow.length,
        contraryNow.length,
        thresholds,
      );
      const resolved = judged === "support" || judged === "oppose";
      conflicts.push({
        knowledgeIds: ids,
        level,
        reason: "polarity",
        resolved,
        ...(resolved ? { resolution: "margin" as const } : {}),
      });
      if (resolved) {
        resolution = "margin";
      } else {
        unresolved = true;
      }
    } else {
      conflicts.push({
        knowledgeIds: ids,
        level,
        reason: "polarity",
        resolved: false,
      });
      unresolved = true;
      resolution = "unresolved";
    }
  }

  const favorable = eligibleOnSide(mutable, "favorable");
  const contrary = eligibleOnSide(mutable, "contrary");
  const eligible = mutable.filter((item) => item.eligible).map((item) => item.evidence);
  const favorableAggregate = aggregateSide(favorable, thresholds.aggregation);
  const contraryAggregate = aggregateSide(contrary, thresholds.aggregation);
  const retrieved = mutable.map((item) => item.evidence);

  let verdict: EvidenceVerdictKind;
  if (input.knowledge.length === 0) {
    verdict = "no-evidence";
  } else if (eligible.length === 0) {
    verdict = "insufficient";
  } else if (unresolved) {
    verdict = "contradictory";
    resolution = "unresolved";
  } else if (minEvidence > 0 && eligible.length < minEvidence) {
    verdict = "insufficient";
  } else if (resolution === "margin") {
    verdict = judgeMargin(
      favorableAggregate,
      contraryAggregate,
      favorable.length,
      contrary.length,
      thresholds,
    );
  } else {
    const judged = judgeMargin(
      favorableAggregate,
      contraryAggregate,
      favorable.length,
      contrary.length,
      thresholds,
    );
    verdict = judged === "contradictory" ? "contradictory" : judged;
  }

  return {
    retrieved,
    eligible,
    favorable,
    contrary,
    conflicts,
    aggregate: {
      favorable: favorableAggregate,
      contrary: contraryAggregate,
      method: thresholds.aggregation,
    },
    resolution,
    verdict,
    calculations: [
      {
        id: "retrieval",
        strategy: "cosine",
        detail: "Knowledge retrieved from the State before voting.",
        values: { retrieved: retrieved.length, eligible: eligible.length },
      },
      {
        id: "aggregation",
        strategy: "aggregation",
        detail:
          "Relevance is similarity times weight. The aggregate sums, averages, or takes the peak. It is not a probability.",
        values: {
          method: thresholds.aggregation,
          favorable: favorableAggregate,
          contrary: contraryAggregate,
        },
      },
      {
        id: "conflicts",
        strategy: "rules",
        detail:
          "Polarity or a contradicts relation creates a conflict. Priority and source resolve it. The highest similarity alone does not choose the side.",
        values: { conflicts: conflicts.length, resolution },
      },
    ],
    criteria: [
      {
        name: "retrieved knowledge",
        passed: input.knowledge.length > 0,
        detail:
          input.knowledge.length > 0
            ? `${input.knowledge.length} knowledge item(s) retrieved.`
            : "No knowledge retrieved.",
      },
      {
        name: "evidence above the threshold",
        passed: eligible.length > 0,
        detail: `${eligible.length} item(s) with similarity >= ${thresholds.minSimilarity} and positive weight.`,
      },
      {
        name: "minimum count",
        passed: minEvidence === 0 || eligible.length >= minEvidence,
        detail:
          minEvidence === 0
            ? "No minimum-count constraint."
            : `The constraint requires ${minEvidence} and there are ${eligible.length}.`,
      },
      {
        name: "conflict",
        passed: !unresolved,
        detail: unresolved
          ? "There is a conflict that priority, source, or margin cannot resolve."
          : conflicts.length === 0
            ? "No conflict among the eligible evidence."
            : `Conflict resolved by ${resolution}.`,
      },
    ],
  };
}

function toMutable(
  item: ScoredKnowledge,
  questionPolarity: QuestionPolarity,
  questionCategories: string[],
  priorityFloor: number,
  minSimilarity: number,
): MutableEvidence {
  const weight = item.weight ?? 1;
  const priority = item.priority ?? 0;
  const categories = item.categories ?? [];
  const categoryMatch =
    questionCategories.length === 0 ||
    categories.some((category) => questionCategories.includes(category));
  const side = polaritySide(item.polarity, questionPolarity);
  const evidence: EvidenceItem = {
    knowledgeId: item.knowledgeId,
    content: item.content,
    similarity: item.similarity,
    polarity: item.polarity,
    relevance: weightedRelevance(item.similarity, weight),
    weight,
    priority,
    side,
    ...(item.source === undefined ? {} : { source: item.source }),
    ...(categories.length === 0 ? {} : { categories: categories.slice() }),
  };
  return {
    evidence,
    eligible:
      categoryMatch &&
      weight > 0 &&
      priority >= priorityFloor &&
      side !== "neutral" &&
      item.similarity >= minSimilarity,
  };
}

function applySupportBoost(
  items: MutableEvidence[],
  relations: KnowledgeRelation[],
  relationWeight: number,
): void {
  if (relationWeight === 0) {
    return;
  }
  for (const relation of relations) {
    if (relation.type !== "supports") {
      continue;
    }
    const source = findEligible(items, relation.from);
    const target = findEligible(items, relation.to);
    if (!source || !target) {
      continue;
    }
    target.evidence = {
      ...target.evidence,
      relevance: target.evidence.relevance * (1 + relationWeight),
    };
  }
}

function findEligible(items: MutableEvidence[], knowledgeId: string): MutableEvidence | undefined {
  return items.find((item) => item.eligible && item.evidence.knowledgeId === knowledgeId);
}

function bothSides(items: MutableEvidence[]): boolean {
  return eligibleOnSide(items, "favorable").length > 0 && eligibleOnSide(items, "contrary").length > 0;
}

function eligibleOnSide(items: MutableEvidence[], side: EvidenceSide): EvidenceItem[] {
  return items
    .filter((item) => item.eligible && item.evidence.side === side)
    .map((item) => item.evidence);
}

function aggregateSide(items: EvidenceItem[], method: AggregationMethod): number {
  return aggregateEvidence(
    items.map((item) => item.relevance),
    method,
  );
}

function sumRelevance(items: EvidenceItem[]): number {
  return items.reduce((total, item) => total + item.relevance, 0);
}

function chooseItem(
  left: MutableEvidence,
  right: MutableEvidence,
  sourcePreference: string[],
): ItemChoice | null {
  if (left.evidence.priority !== right.evidence.priority) {
    const winner = left.evidence.priority > right.evidence.priority ? left : right;
    const loser = winner === left ? right : left;
    return { by: "priority", item: winner, loser };
  }
  const leftRank = bestSourceRank([left.evidence.source], sourcePreference);
  const rightRank = bestSourceRank([right.evidence.source], sourcePreference);
  if (leftRank === null && rightRank === null) {
    return null;
  }
  if (leftRank !== null && rightRank !== null && leftRank === rightRank) {
    return null;
  }
  const leftWins = rightRank === null || (leftRank !== null && leftRank < rightRank);
  return {
    by: "source",
    item: leftWins ? left : right,
    loser: leftWins ? right : left,
  };
}

function chooseSide(
  favorable: EvidenceItem[],
  contrary: EvidenceItem[],
  sourcePreference: string[],
): SideChoice | null {
  const favorableSource = bestSourceRank(
    favorable.map((item) => item.source),
    sourcePreference,
  );
  const contrarySource = bestSourceRank(
    contrary.map((item) => item.source),
    sourcePreference,
  );
  if (!(favorableSource === null && contrarySource === null) && favorableSource !== contrarySource) {
    const favorableWins =
      contrarySource === null || (favorableSource !== null && favorableSource < contrarySource);
    const side = favorableWins ? "favorable" : "contrary";
    const kept = (favorableWins ? favorable : contrary)[0];
    return kept ? { by: "source", side, keptId: kept.knowledgeId } : null;
  }

  const favorablePriority = maxPriority(favorable);
  const contraryPriority = maxPriority(contrary);
  if (favorablePriority === contraryPriority) {
    return null;
  }
  const favorableWins = favorablePriority > contraryPriority;
  const side = favorableWins ? "favorable" : "contrary";
  const kept = (favorableWins ? favorable : contrary)[0];
  return kept ? { by: "priority", side, keptId: kept.knowledgeId } : null;
}

function maxPriority(items: EvidenceItem[]): number {
  return items.reduce((highest, item) => Math.max(highest, item.priority), Number.NEGATIVE_INFINITY);
}
