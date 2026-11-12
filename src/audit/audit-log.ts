import { randomUUID } from "node:crypto";
import type { ScoredKnowledge } from "../core/interfaces/vector-store.js";
import type { DecideRequest, DecideResponse, DecisionAnswer, DecisionQuestion } from "../core/types/decision.js";
import type { DecisionStateContext } from "../core/types/state.js";
import type { DecisionThresholds } from "../core/types/thresholds.js";
import { clone } from "../utils/clone.js";

export interface AuditSnapshot {
  questionId: string;
  question: DecisionQuestion;
  questionVector: number[];
  optionVectors: Record<string, number[]>;
  knowledge: ScoredKnowledge[];
  state: DecisionStateContext;
  answer: DecisionAnswer;
}

export interface DecisionAuditRecord {
  id: string;
  createdAt: string;
  stateId: string;
  stateVersion: number;
  modelId: string;
  strategies: { type: string; version: string }[];
  thresholds: DecisionThresholds;
  request: DecideRequest;
  response: DecideResponse;
  snapshots: AuditSnapshot[];
}

export interface AuditLog {
  append(record: DecisionAuditRecord): Promise<void>;
  get(id: string): Promise<DecisionAuditRecord | null>;
  list(stateId?: string): Promise<DecisionAuditRecord[]>;
}

export interface ReplayReport {
  auditId: string;
  storedStateVersion: number;
  currentStateVersion: number | null;
  storedModelId: string;
  currentModelId: string;
  modelMatches: boolean;
  stateVersionMatches: boolean;
  strategyVersionsMatch: boolean;
  decisionsMatch: boolean;
  stored: DecideResponse;
  replayed: DecideResponse;
}

export class InMemoryAuditLog implements AuditLog {
  private readonly records: DecisionAuditRecord[] = [];

  async append(record: DecisionAuditRecord): Promise<void> {
    this.records.push(clone(record));
  }

  async get(id: string): Promise<DecisionAuditRecord | null> {
    const record = this.records.find((item) => item.id === id);
    return record ? clone(record) : null;
  }

  async list(stateId?: string): Promise<DecisionAuditRecord[]> {
    const records = stateId
      ? this.records.filter((item) => item.stateId === stateId)
      : this.records;
    return clone(records);
  }
}

export function createAuditId(): string {
  return randomUUID();
}
