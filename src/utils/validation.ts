import {
  InvalidDecisionError,
  InvalidThresholdError,
} from "../core/errors/index.js";
import type { KnowledgeInput, Polarity } from "../core/types/knowledge.js";
import type { ScoreScale } from "../core/types/decision.js";
import type { DecisionThresholds } from "../core/types/thresholds.js";
import type {
  KnowledgeRelation,
  StateConstraint,
} from "../core/types/state.js";
import { DEFAULT_THRESHOLDS } from "../core/types/thresholds.js";
import { assertJsonValue, assertPolarity } from "./vector.js";

export function resolveThresholds(
  partial?: Partial<DecisionThresholds>,
): DecisionThresholds {
  const resolved: DecisionThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...partial,
  };
  validateThresholds(resolved);
  return resolved;
}

export function validateThresholds(thresholds: DecisionThresholds): void {
  assertUnitInterval(thresholds.minSimilarity, "minSimilarity");
  assertNonNegativeFinite(thresholds.evidenceMargin, "evidenceMargin");
  assertNonNegativeFinite(thresholds.contradictionMargin, "contradictionMargin");
  assertNonNegativeFinite(thresholds.choiceMargin, "choiceMargin");
  if (!Number.isFinite(thresholds.choiceEvidenceWeight)) {
    throw new InvalidThresholdError("choiceEvidenceWeight must be a finite number.");
  }
  if (!Number.isInteger(thresholds.topK) || thresholds.topK < 1) {
    throw new InvalidThresholdError("topK must be an integer greater than or equal to 1.");
  }
  assertOptionalCount(thresholds.positiveTopK, "positiveTopK");
  assertOptionalCount(thresholds.negativeTopK, "negativeTopK");
  assertOptionalCount(thresholds.neutralTopK, "neutralTopK");
  if (!["sum", "mean", "peak"].includes(thresholds.aggregation)) {
    throw new InvalidThresholdError("aggregation must be sum, mean, or peak.");
  }
  if (!["priority", "margin"].includes(thresholds.conflictResolution)) {
    throw new InvalidThresholdError("conflictResolution must be priority or margin.");
  }
  assertNonNegativeFinite(thresholds.relationWeight, "relationWeight");
}

export function validateScale(scale: ScoreScale | undefined): asserts scale is ScoreScale {
  if (!scale) {
    throw new InvalidDecisionError("Score requires a scale with min, max, and step.");
  }
  if (
    !Number.isFinite(scale.min) ||
    !Number.isFinite(scale.max) ||
    !Number.isFinite(scale.step)
  ) {
    throw new InvalidDecisionError("The score scale requires finite min, max, and step.");
  }
  if (scale.min >= scale.max) {
    throw new InvalidDecisionError("The score scale requires min to be less than max.");
  }
  if (scale.step <= 0) {
    throw new InvalidDecisionError("The score scale requires step to be greater than zero.");
  }
}

export function validateKnowledgeInput(input: KnowledgeInput): void {
  if (!input.id || input.id.trim().length === 0) {
    throw new InvalidDecisionError("Knowledge is missing an id.");
  }
  if (!input.content || input.content.trim().length === 0) {
    throw new InvalidDecisionError(`Knowledge ${input.id} has no content.`);
  }
  assertPolarity(input.polarity);
  if (input.metadata !== undefined) {
    assertJsonValue(input.metadata, "metadata");
  }
  if (input.categories !== undefined) {
    assertLabels(input.categories, "category");
  }
  if (input.weight !== undefined && (!Number.isFinite(input.weight) || input.weight < 0)) {
    throw new InvalidDecisionError(`Invalid weight on knowledge ${input.id}.`);
  }
  if (input.priority !== undefined && !Number.isFinite(input.priority)) {
    throw new InvalidDecisionError(`Invalid priority on knowledge ${input.id}.`);
  }
  if (input.source !== undefined && input.source.trim().length === 0) {
    throw new InvalidDecisionError(`Empty source on knowledge ${input.id}.`);
  }
}

export function validateKnowledgeList(items: KnowledgeInput[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    validateKnowledgeInput(item);
    if (seen.has(item.id)) {
      throw new InvalidDecisionError(`Duplicate knowledge in the same operation: ${item.id}`);
    }
    seen.add(item.id);
  }
}

export function validateStateGraph(input: {
  categories?: string[];
  relations?: KnowledgeRelation[];
  constraints?: StateConstraint[];
  knowledgeIds: string[];
  metadata?: Record<string, unknown>;
}): void {
  if (input.metadata !== undefined) {
    assertJsonValue(input.metadata, "State metadata");
  }
  if (input.categories !== undefined) {
    assertLabels(input.categories, "State category");
  }
  const ids = new Set(input.knowledgeIds);
  const relationIds = new Set<string>();
  for (const relation of input.relations ?? []) {
    if (!relation.id || relation.id.trim().length === 0) {
      throw new InvalidDecisionError("Relation is missing an id.");
    }
    if (relationIds.has(relation.id)) {
      throw new InvalidDecisionError(`Duplicate relation: ${relation.id}`);
    }
    relationIds.add(relation.id);
    if (!ids.has(relation.from) || !ids.has(relation.to)) {
      throw new InvalidDecisionError(
        `Relation ${relation.id} points to knowledge that does not exist.`,
      );
    }
    if (relation.from === relation.to) {
      throw new InvalidDecisionError(`Relation ${relation.id} cannot connect a knowledge item to itself.`);
    }
    if (!["supports", "contradicts", "depends-on", "refines"].includes(relation.type)) {
      throw new InvalidDecisionError(`Invalid relation type: ${relation.type}`);
    }
  }
  const constraintIds = new Set<string>();
  for (const constraint of input.constraints ?? []) {
    if (!constraint.id || constraint.id.trim().length === 0 || constraint.description.trim().length === 0) {
      throw new InvalidDecisionError("Constraint is missing an id or a description.");
    }
    if (constraintIds.has(constraint.id)) {
      throw new InvalidDecisionError(`Duplicate constraint: ${constraint.id}`);
    }
    constraintIds.add(constraint.id);
    if (constraint.categories !== undefined) {
      assertLabels(constraint.categories, "constraint category");
    }
    if (constraint.kind === "minimum-evidence") {
      if (!Number.isInteger(constraint.minEvidence) || (constraint.minEvidence ?? 0) < 1) {
        throw new InvalidDecisionError(
          `Constraint ${constraint.id} requires minEvidence to be an integer greater than or equal to 1.`,
        );
      }
    } else if (constraint.kind === "prefer-source") {
      if (!constraint.sources || constraint.sources.length === 0) {
        throw new InvalidDecisionError(`Constraint ${constraint.id} requires sources.`);
      }
      assertLabels(constraint.sources, "source");
    } else if (constraint.kind === "minimum-priority") {
      if (constraint.minimumPriority === undefined || !Number.isFinite(constraint.minimumPriority)) {
        throw new InvalidDecisionError(`Constraint ${constraint.id} requires a finite minimumPriority.`);
      }
    } else {
      throw new InvalidDecisionError(`Invalid constraint type: ${constraint.kind}`);
    }
  }
}

function assertLabels(values: string[], label: string): void {
  for (const value of values) {
    if (!value || value.trim().length === 0) {
      throw new InvalidDecisionError(`${label} is empty.`);
    }
  }
}

export function isPolarity(value: string): value is Polarity {
  return value === "positive" || value === "negative" || value === "neutral";
}

function assertOptionalCount(value: number | undefined, label: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidThresholdError(
      `${label} must be an integer greater than or equal to 0.`,
    );
  }
}

function assertUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new InvalidThresholdError(`${label} must be between -1 and 1.`);
  }
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidThresholdError(`${label} must be a finite number greater than or equal to zero.`);
  }
}
