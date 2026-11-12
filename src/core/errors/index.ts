export class DecisionEngineError extends Error {
  readonly code: string;

  constructor(message: string, code = "DECISION_ENGINE_ERROR") {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class StateNotFoundError extends DecisionEngineError {
  constructor(readonly stateId: string) {
    super(`State not found: ${stateId}`, "STATE_NOT_FOUND");
  }
}

export class KnowledgeNotFoundError extends DecisionEngineError {
  constructor(
    readonly stateId: string,
    readonly knowledgeId: string,
  ) {
    super(
      `Knowledge not found: ${knowledgeId} in State ${stateId}`,
      "KNOWLEDGE_NOT_FOUND",
    );
  }
}

export class DuplicateStateError extends DecisionEngineError {
  constructor(readonly stateId: string) {
    super(`A State with id ${stateId} already exists`, "DUPLICATE_STATE");
  }
}

export class DuplicateKnowledgeError extends DecisionEngineError {
  constructor(
    readonly stateId: string,
    readonly knowledgeId: string,
  ) {
    super(
      `Knowledge ${knowledgeId} already exists in State ${stateId}`,
      "DUPLICATE_KNOWLEDGE",
    );
  }
}

export class IncompatibleDimensionsError extends DecisionEngineError {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Incompatible embedding dimensions. Expected ${expected}, received ${actual}.`,
      "INCOMPATIBLE_DIMENSIONS",
    );
  }
}

export class IncompatibleModelError extends DecisionEngineError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Incompatible embeddings. The current provider is "${expected}", but the State was processed with "${actual}". Call states.reprocess(stateId) to generate the embeddings again.`,
      "INCOMPATIBLE_MODEL",
    );
  }
}

export class InvalidVectorError extends DecisionEngineError {
  constructor(message: string) {
    super(message, "INVALID_VECTOR");
  }
}

export class InvalidThresholdError extends DecisionEngineError {
  constructor(message: string) {
    super(message, "INVALID_THRESHOLD");
  }
}

export class InvalidDecisionError extends DecisionEngineError {
  constructor(message: string) {
    super(message, "INVALID_DECISION");
  }
}

export class EmbeddingProviderError extends DecisionEngineError {
  constructor(message: string) {
    super(message, "EMBEDDING_PROVIDER_ERROR");
  }
}

export class PersistenceError extends DecisionEngineError {
  constructor(message: string) {
    super(message, "PERSISTENCE_ERROR");
  }
}

export class SchemaMismatchError extends DecisionEngineError {
  constructor(
    readonly table: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      actual < 0
        ? `Table ${table} already exists without an embedding vector(${expected}) column. Migration does not rewrite existing tables.`
        : `Table ${table} already exists with vector(${actual}), but the configuration asked for ${expected}. Migration does not alter the column. Use another tablePrefix or a database with the same dimension.`,
      "SCHEMA_MISMATCH",
    );
  }
}
