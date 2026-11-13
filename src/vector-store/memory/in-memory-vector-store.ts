import type {
  KnowledgeVector,
  ScoredKnowledge,
  VectorSearchInput,
  VectorStore,
} from "../../core/interfaces/vector-store.js";
import {
  IncompatibleDimensionsError,
  InvalidDecisionError,
} from "../../core/errors/index.js";
import { clone } from "../../utils/clone.js";
import { cosineSimilarity } from "../../utils/similarity.js";
import { assertPolarity, assertValidVector } from "../../utils/vector.js";

export class InMemoryVectorStore implements VectorStore {
  private readonly items = new Map<string, KnowledgeVector>();

  async upsert(vector: KnowledgeVector): Promise<void> {
    this.assertStorable(vector);
    this.items.set(keyOf(vector.stateId, vector.knowledgeId), clone(vector));
  }

  async upsertMany(vectors: KnowledgeVector[]): Promise<void> {
    for (const vector of vectors) {
      this.assertStorable(vector);
    }
    for (const vector of vectors) {
      this.items.set(keyOf(vector.stateId, vector.knowledgeId), clone(vector));
    }
  }

  async search(input: VectorSearchInput): Promise<ScoredKnowledge[]> {
    assertSearch(input);
    const scored: ScoredKnowledge[] = [];

    for (const stored of this.items.values()) {
      if (stored.stateId !== input.stateId || stored.modelId !== input.modelId) {
        continue;
      }
      if (input.polarity !== undefined && stored.polarity !== input.polarity) {
        continue;
      }
      if (input.knowledgeIds !== undefined && !input.knowledgeIds.includes(stored.knowledgeId)) {
        continue;
      }
      if (
        stored.dimensions !== input.vector.length ||
        stored.vector.length !== input.vector.length
      ) {
        throw new IncompatibleDimensionsError(
          input.vector.length,
          stored.vector.length,
        );
      }

      scored.push({
        stateId: stored.stateId,
        knowledgeId: stored.knowledgeId,
        content: stored.content,
        polarity: stored.polarity,
        similarity: cosineSimilarity(input.vector, stored.vector),
        vector: stored.vector.slice(),
        modelId: stored.modelId,
        dimensions: stored.dimensions,
        contentHash: stored.contentHash,
        ...(stored.metadata === undefined ? {} : { metadata: clone(stored.metadata) }),
      });
    }

    scored.sort(
      (left, right) =>
        right.similarity - left.similarity ||
        left.knowledgeId.localeCompare(right.knowledgeId),
    );

    if (input.limit === undefined) {
      return scored;
    }
    return scored.slice(0, input.limit);
  }

  async get(stateId: string, knowledgeId: string): Promise<KnowledgeVector | null> {
    const stored = this.items.get(keyOf(stateId, knowledgeId));
    return stored ? clone(stored) : null;
  }

  async delete(stateId: string, knowledgeId: string): Promise<void> {
    this.items.delete(keyOf(stateId, knowledgeId));
  }

  async deleteByState(stateId: string): Promise<void> {
    for (const key of this.items.keys()) {
      if (key.startsWith(`${stateId}\0`)) {
        this.items.delete(key);
      }
    }
  }

  private assertStorable(vector: KnowledgeVector): void {
    if (!vector.stateId || vector.stateId.trim().length === 0) {
      throw new InvalidDecisionError("Vector is missing a stateId.");
    }
    if (!vector.knowledgeId || vector.knowledgeId.trim().length === 0) {
      throw new InvalidDecisionError("Vector is missing a knowledgeId.");
    }
    if (!vector.modelId || vector.modelId.trim().length === 0) {
      throw new InvalidDecisionError("Vector is missing a modelId.");
    }
    if (!vector.content || vector.content.trim().length === 0) {
      throw new InvalidDecisionError("Vector has no content.");
    }
    assertPolarity(vector.polarity);
    if (vector.dimensions !== vector.vector.length) {
      throw new IncompatibleDimensionsError(vector.dimensions, vector.vector.length);
    }
    assertValidVector(vector.vector, vector.dimensions);
  }
}

function keyOf(stateId: string, knowledgeId: string): string {
  return `${stateId}\0${knowledgeId}`;
}

function assertSearch(input: VectorSearchInput): void {
  if (!input.stateId || input.stateId.trim().length === 0) {
    throw new InvalidDecisionError("Search is missing a stateId.");
  }
  if (!input.modelId || input.modelId.trim().length === 0) {
    throw new InvalidDecisionError("Search is missing a modelId.");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new InvalidDecisionError("Search limit must be a positive integer.");
  }
}
