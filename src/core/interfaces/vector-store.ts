import type { Polarity } from "../types/knowledge.js";
import type { PersistenceSession } from "../persistence/transaction.js";

export interface KnowledgeVector {
  stateId: string;
  knowledgeId: string;
  content: string;
  polarity: Polarity;
  vector: number[];
  modelId: string;
  dimensions: number;
  contentHash: string;
  categories?: string[];
  weight?: number;
  priority?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchInput {
  stateId: string;
  vector: number[];
  modelId: string;
  limit?: number;
  polarity?: Polarity;
  knowledgeIds?: readonly string[];
}

export interface ScoredKnowledge {
  stateId: string;
  knowledgeId: string;
  content: string;
  polarity: Polarity;
  similarity: number;
  vector: number[];
  modelId: string;
  dimensions: number;
  contentHash: string;
  categories?: string[];
  weight?: number;
  priority?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  upsert(vector: KnowledgeVector, session?: PersistenceSession): Promise<void>;
  upsertMany(vectors: KnowledgeVector[], session?: PersistenceSession): Promise<void>;
  search(input: VectorSearchInput): Promise<ScoredKnowledge[]>;
  get(
    stateId: string,
    knowledgeId: string,
    session?: PersistenceSession,
  ): Promise<KnowledgeVector | null>;
  delete(stateId: string, knowledgeId: string, session?: PersistenceSession): Promise<void>;
  deleteByState(stateId: string, session?: PersistenceSession): Promise<void>;
}
