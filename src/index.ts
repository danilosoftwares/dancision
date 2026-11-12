export {
  DecisionEngine,
  type DecisionEngineOptions,
} from "./core/engine/decision-engine.js";
export {
  DecisionEngineError,
  DuplicateKnowledgeError,
  DuplicateStateError,
  EmbeddingProviderError,
  IncompatibleDimensionsError,
  IncompatibleModelError,
  InvalidDecisionError,
  InvalidThresholdError,
  InvalidVectorError,
  KnowledgeNotFoundError,
  PersistenceError,
  SchemaMismatchError,
  StateNotFoundError,
} from "./core/errors/index.js";
export type {
  CalculationStep,
  ChoiceAlternative,
  ChoiceAnswer,
  ChoiceOption,
  ChoiceQuestion,
  DecideRequest,
  DecideResponse,
  DecisionAnswer,
  DecisionAnswerBase,
  DecisionCriterion,
  DecisionExplanation,
  DecisionQuestion,
  DecisionQuestionBase,
  EvidenceConflict,
  EvidenceItem,
  KnowledgeInput,
  KnowledgePatch,
  KnowledgeRecord,
  KnowledgeRelation,
  KnowledgeRelationType,
  NoulAnswer,
  NoulQuestion,
  Polarity,
  QuestionCondition,
  QuestionPolarity,
  ScoreAnswer,
  ScoreQuestion,
  ScoreScale,
  SimilarityBreakdown,
  StateConstraint,
  StateConstraintKind,
  StateInput,
  StatePatch,
  StateRecord,
  UndeterminedReason,
} from "./core/types/index.js";
export type {
  AggregationMethod,
  ConflictResolution,
  DecisionThresholds,
} from "./core/types/index.js";
export { DEFAULT_THRESHOLDS, normalizeState, toDecisionStateContext } from "./core/types/index.js";
export type {
  DecisionStrategy,
  StrategyDecision,
  EmbeddingCache,
  EmbeddingProvider,
  KnowledgeVector,
  ScoredKnowledge,
  StateRepository,
  StrategyContext,
  VectorSearchInput,
  VectorStore,
} from "./core/interfaces/index.js";
export { ChoiceStrategy } from "./decisions/choice/choice-strategy.js";
export { DecisionRegistry } from "./decisions/decision-registry.js";
export { NoulStrategy } from "./decisions/noul/noul-strategy.js";
export { snapToScale } from "./decisions/score/scale.js";
export { ScoreStrategy } from "./decisions/score/score-strategy.js";
export { EmbeddingService } from "./embeddings/embedding-service.js";
export { InMemoryEmbeddingCache } from "./embeddings/in-memory-embedding-cache.js";
export {
  DEFAULT_TRANSFORMERS_DIMENSIONS,
  DEFAULT_TRANSFORMERS_MODEL,
  TransformersEmbeddingProvider,
  type TransformersDtype,
  type TransformersEmbeddingProviderOptions,
} from "./embeddings/providers/transformers-embedding-provider.js";
export { StateManager } from "./state/state-manager.js";
export {
  judgeEvidence,
  polarityPeaks,
  toEvidence,
  vote,
  type EvidenceVerdict,
  type VotingSides,
} from "./strategies/cosine/cosine-evidence.js";
export { createInMemoryDecisionEngine } from "./create-in-memory-engine.js";
export type { InMemoryDecisionEngineOptions } from "./create-in-memory-engine.js";
export { InMemoryStateRepository } from "./vector-store/memory/in-memory-state-repository.js";
export { InMemoryVectorStore } from "./vector-store/memory/in-memory-vector-store.js";
export { cosineSimilarity } from "./utils/similarity.js";
export { resolveThresholds, validateScale, validateThresholds } from "./utils/validation.js";
export {
  InMemoryAuditLog,
  type AuditLog,
  type AuditSnapshot,
  type DecisionAuditRecord,
  type ReplayReport,
} from "./audit/audit-log.js";
export {
  EVALUATION_METHODOLOGY,
  calibrateThresholds,
  evaluateDecisions,
  type CalibrationReport,
  type EvaluationCase,
  type EvaluationReport,
  type ExpectedDecision,
  type ThresholdGrid,
} from "./evaluation/evaluation-engine.js";
export {
  EVIDENCE_ENGINE_VERSION,
  assessEvidence,
  type EvidenceAssessment,
  type EvidenceVerdictKind,
} from "./evidence/evidence-engine.js";
export { cosineMeasure } from "./strategies/similarity/similarity-measure.js";
