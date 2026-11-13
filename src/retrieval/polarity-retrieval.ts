import type { VectorStore, ScoredKnowledge } from "../core/interfaces/vector-store.js";
import type { Polarity } from "../core/types/knowledge.js";
import type { StateRecord } from "../core/types/state.js";
import type { DecisionThresholds } from "../core/types/thresholds.js";

const POLARITIES: readonly Polarity[] = ["positive", "negative", "neutral"];

export interface EvidenceRetrievalInput {
  state: StateRecord;
  questionVector: number[];
  modelId: string;
  thresholds: DecisionThresholds;
  vectors: VectorStore;
  questionCategories?: string[];
}

export interface EvidenceRetrieval {
  retrieve(input: EvidenceRetrievalInput): Promise<ScoredKnowledge[]>;
}

export const polarityBalancedRetrieval: EvidenceRetrieval = {
  async retrieve(input) {
    const found = new Map<string, ScoredKnowledge>();
    for (const polarity of POLARITIES) {
      const limit = polarityLimit(input.thresholds, polarity);
      if (limit < 1) {
        continue;
      }
      const knowledgeIds = eligibleKnowledgeIds(input.state, polarity, input.questionCategories);
      if (knowledgeIds !== undefined && knowledgeIds.length > 0) {
        const targeted = await input.vectors.search({
          stateId: input.state.id,
          vector: input.questionVector,
          modelId: input.modelId,
          limit,
          polarity,
          knowledgeIds,
        });
        collect(found, targeted, polarity, input.state.id, knowledgeIds);
      }
      const background = await input.vectors.search({
        stateId: input.state.id,
        vector: input.questionVector,
        modelId: input.modelId,
        limit,
        polarity,
      });
      collect(found, background, polarity, input.state.id, undefined);
    }

    return [...found.values()].sort(
      (left, right) =>
        right.similarity - left.similarity ||
        left.knowledgeId.localeCompare(right.knowledgeId),
    );
  },
};

function collect(
  found: Map<string, ScoredKnowledge>,
  rows: ScoredKnowledge[],
  polarity: Polarity,
  stateId: string,
  knowledgeIds: string[] | undefined,
): void {
  for (const row of rows) {
    if (row.polarity !== polarity) {
      continue;
    }
    if (
      row.stateId === stateId &&
      knowledgeIds !== undefined &&
      !knowledgeIds.includes(row.knowledgeId)
    ) {
      continue;
    }
    const key = `${row.stateId}\0${row.knowledgeId}`;
    const current = found.get(key);
    if (!current || row.similarity > current.similarity) {
      found.set(key, row);
    }
  }
}

export function polarityLimit(thresholds: DecisionThresholds, polarity: Polarity): number {
  const specific =
    polarity === "positive"
      ? thresholds.positiveTopK
      : polarity === "negative"
        ? thresholds.negativeTopK
        : thresholds.neutralTopK;
  return specific ?? thresholds.topK;
}

function eligibleKnowledgeIds(
  state: StateRecord,
  polarity: Polarity,
  categories: string[] | undefined,
): string[] | undefined {
  if (categories === undefined || categories.length === 0) {
    return undefined;
  }
  return state.knowledge
    .filter(
      (item) => item.polarity === polarity && sharesCategory(item.categories, categories),
    )
    .map((item) => item.id);
}

function sharesCategory(
  knowledgeCategories: string[] | undefined,
  questionCategories: string[],
): boolean {
  if (!knowledgeCategories || knowledgeCategories.length === 0) {
    return false;
  }
  return knowledgeCategories.some((category) => questionCategories.includes(category));
}
