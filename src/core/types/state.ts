import type { KnowledgeInput, KnowledgeRecord } from "./knowledge.js";

export type KnowledgeRelationType =
  | "supports"
  | "contradicts"
  | "depends-on"
  | "refines";

export interface KnowledgeRelation {
  id: string;
  from: string;
  to: string;
  type: KnowledgeRelationType;
}

export type StateConstraintKind =
  | "minimum-evidence"
  | "prefer-source"
  | "minimum-priority";

export interface StateConstraint {
  id: string;
  description: string;
  categories?: string[];
  kind: StateConstraintKind;
  minEvidence?: number;
  sources?: string[];
  minimumPriority?: number;
}

export interface StateInput {
  id: string;
  name: string;
  domain?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  categories?: string[];
  relations?: KnowledgeRelation[];
  constraints?: StateConstraint[];
  knowledge?: KnowledgeInput[];
}

export interface StatePatch {
  name?: string;
  description?: string;
  domain?: string;
  metadata?: Record<string, unknown>;
  categories?: string[];
  relations?: KnowledgeRelation[];
  constraints?: StateConstraint[];
}

export interface StateRecord {
  id: string;
  name: string;
  domain?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  categories: string[];
  relations: KnowledgeRelation[];
  constraints: StateConstraint[];
  knowledge: KnowledgeRecord[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function normalizeState(state: StateRecord): StateRecord {
  return {
    ...state,
    version: Number.isInteger(state.version) ? state.version : 1,
    categories: state.categories ?? [],
    relations: state.relations ?? [],
    constraints: state.constraints ?? [],
  };
}

export interface DecisionStateContext {
  id: string;
  version: number;
  domain?: string;
  categories: string[];
  relations: KnowledgeRelation[];
  constraints: StateConstraint[];
}

export function toDecisionStateContext(state: StateRecord): DecisionStateContext {
  const normalized = normalizeState(state);
  return {
    id: normalized.id,
    version: normalized.version,
    ...(normalized.domain === undefined ? {} : { domain: normalized.domain }),
    categories: normalized.categories,
    relations: normalized.relations,
    constraints: normalized.constraints,
  };
}
