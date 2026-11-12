import type { AuditLog } from "./audit/audit-log.js";
import type { EmbeddingCache } from "./core/interfaces/embedding-cache.js";
import type { EmbeddingProvider } from "./core/interfaces/embedding-provider.js";
import { DecisionEngine } from "./core/engine/decision-engine.js";
import type { DecisionThresholds } from "./core/types/thresholds.js";
import { InMemoryStateRepository } from "./vector-store/memory/in-memory-state-repository.js";
import { InMemoryVectorStore } from "./vector-store/memory/in-memory-vector-store.js";

export interface InMemoryDecisionEngineOptions {
  cache?: EmbeddingCache;
  thresholds?: Partial<DecisionThresholds>;
  audit?: AuditLog;
}

export function createInMemoryDecisionEngine(
  embeddings: EmbeddingProvider,
  options: InMemoryDecisionEngineOptions = {},
): DecisionEngine {
  return new DecisionEngine({
    embeddings,
    vectors: new InMemoryVectorStore(),
    states: new InMemoryStateRepository(),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
}
