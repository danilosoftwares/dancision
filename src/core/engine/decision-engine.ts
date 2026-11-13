import type { EmbeddingCache } from "../interfaces/embedding-cache.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { StateRepository } from "../interfaces/state-repository.js";
import type {
  DecisionStrategy,
  StrategyContext,
  StrategyDecision,
} from "../interfaces/decision-strategy.js";
import type { ScoredKnowledge, VectorStore } from "../interfaces/vector-store.js";
import {
  EmbeddingProviderError,
  IncompatibleDimensionsError,
  IncompatibleModelError,
  InvalidDecisionError,
  StateNotFoundError,
} from "../errors/index.js";
import type {
  ChoiceQuestion,
  DecideRequest,
  DecideResponse,
  DecisionAnswer,
  DecisionExplanation,
  DecisionQuestion,
} from "../types/decision.js";
import { knowledgeAttributes } from "../types/knowledge.js";
import type { DecisionThresholds } from "../types/thresholds.js";
import type { StateRecord } from "../types/state.js";
import { toDecisionStateContext } from "../types/state.js";
import {
  createAuditId,
  type AuditLog,
  type AuditSnapshot,
  type ReplayReport,
} from "../../audit/audit-log.js";
import { ChoiceStrategy } from "../../decisions/choice/choice-strategy.js";
import { DecisionRegistry } from "../../decisions/decision-registry.js";
import { NoulStrategy } from "../../decisions/noul/noul-strategy.js";
import { ScoreStrategy } from "../../decisions/score/score-strategy.js";
import { EmbeddingService } from "../../embeddings/embedding-service.js";
import { StateManager } from "../../state/state-manager.js";
import { cosineMeasure } from "../../strategies/similarity/similarity-measure.js";
import { createThresholdPolicy } from "../../strategies/thresholds/threshold-policy.js";
import { validateScale } from "../../utils/validation.js";
import {
  polarityBalancedRetrieval,
  type EvidenceRetrieval,
} from "../../retrieval/polarity-retrieval.js";

export interface PersistenceDiagnostic {
  kind: "orphan-vector" | "foreign-state";
  stateId: string;
  knowledgeId: string;
  detail: string;
}

export interface DecisionEngineOptions {
  embeddings: EmbeddingProvider;
  vectors: VectorStore;
  states: StateRepository;
  cache?: EmbeddingCache;
  thresholds?: Partial<DecisionThresholds>;
  audit?: AuditLog;
  retrieval?: EvidenceRetrieval;
  onDiagnostic?: (event: PersistenceDiagnostic) => void;
}

export class DecisionEngine {
  readonly states: StateManager;
  readonly audit?: AuditLog;
  private readonly embeddings: EmbeddingProvider;
  private readonly vectors: VectorStore;
  private readonly embeddingService: EmbeddingService;
  private readonly thresholds: DecisionThresholds;
  private readonly retrieval: EvidenceRetrieval;
  private readonly onDiagnostic?: (event: PersistenceDiagnostic) => void;
  private readonly registry = new DecisionRegistry();

  constructor(options: DecisionEngineOptions) {
    this.embeddings = options.embeddings;
    this.vectors = options.vectors;
    this.thresholds = createThresholdPolicy(options.thresholds);
    this.audit = options.audit;
    this.retrieval = options.retrieval ?? polarityBalancedRetrieval;
    this.onDiagnostic = options.onDiagnostic;
    this.embeddingService = new EmbeddingService(options.embeddings, options.cache);
    this.states = new StateManager(
      options.states,
      options.vectors,
      this.embeddingService,
      options.embeddings,
    );
    this.registry.register(new NoulStrategy());
    this.registry.register(new ChoiceStrategy());
    this.registry.register(new ScoreStrategy());
  }

  registerStrategy(strategy: DecisionStrategy): void {
    this.registry.register(strategy);
  }

  async decide(request: DecideRequest): Promise<DecideResponse> {
    const prepared = await this.prepare(request);
    const response: DecideResponse = {
      stateId: request.stateId,
      answers: prepared.answers,
    };
    if (this.audit) {
      await this.audit.append({
        id: createAuditId(),
        createdAt: new Date().toISOString(),
        stateId: request.stateId,
        stateVersion: prepared.state.version,
        modelId: this.embeddings.modelId,
        strategies: this.registry.list().map((strategy) => ({
          type: strategy.type,
          version: strategy.version,
        })),
        thresholds: this.thresholds,
        request,
        response,
        snapshots: prepared.snapshots,
      });
    }
    return response;
  }

  async replay(auditId: string): Promise<ReplayReport> {
    if (!this.audit) {
      throw new InvalidDecisionError("The engine was not given an AuditLog.");
    }
    const record = await this.audit.get(auditId);
    if (!record) {
      throw new InvalidDecisionError(`Audit record not found: ${auditId}`);
    }

    const answers: DecisionAnswer[] = [];
    for (const snapshot of record.snapshots) {
      if (!conditionMet(snapshot.question, answers)) {
        answers.push(
          skippedAnswer(snapshot.question, record.stateId, record.stateVersion, record.modelId, record.thresholds, this.versionOf(snapshot.question.type)),
        );
        continue;
      }
      const strategy = this.registry.get(snapshot.question.type);
      const context = this.contextFromSnapshot(snapshot, record.thresholds, record.modelId);
      answers.push(ensureExplanation(strategy.decide(context), context, strategy.version));
    }

    const current = await this.states.get(record.stateId).catch(() => null);
    const currentStrategies = new Map(
      this.registry.list().map((strategy) => [strategy.type, strategy.version]),
    );
    const strategyVersionsMatch = record.strategies.every(
      (strategy) => currentStrategies.get(strategy.type) === strategy.version,
    );

    return {
      auditId: record.id,
      storedStateVersion: record.stateVersion,
      currentStateVersion: current?.version ?? null,
      storedModelId: record.modelId,
      currentModelId: this.embeddings.modelId,
      modelMatches: record.modelId === this.embeddings.modelId,
      stateVersionMatches: current?.version === record.stateVersion,
      strategyVersionsMatch,
      decisionsMatch: answers.every((answer, index) =>
        sameDecision(answer, record.response.answers[index]),
      ),
      stored: record.response,
      replayed: { stateId: record.stateId, answers },
    };
  }

  private versionOf(type: string): string {
    return this.registry.list().find((strategy) => strategy.type === type)?.version ?? "unversioned";
  }

  private contextFromSnapshot(
    snapshot: AuditSnapshot,
    thresholds: DecisionThresholds,
    modelId: string,
  ): StrategyContext {
    return {
      question: snapshot.question,
      questionVector: snapshot.questionVector,
      knowledge: snapshot.knowledge,
      optionVectors: new Map(Object.entries(snapshot.optionVectors)),
      thresholds,
      state: snapshot.state,
      modelId,
      similarity: cosineMeasure,
    };
  }

  private async prepare(request: DecideRequest): Promise<{
    state: StateRecord;
    answers: DecisionAnswer[];
    snapshots: AuditSnapshot[];
  }> {
    if (!request.stateId || request.stateId.trim().length === 0) {
      throw new InvalidDecisionError("decide requires a stateId.");
    }
    if (!request.questions || request.questions.length === 0) {
      throw new InvalidDecisionError("Provide at least one question.");
    }

    const questionIds = new Set<string>();
    request.questions.forEach((question, index) => {
      assertQuestion(question);
      if (questionIds.has(question.id)) {
        throw new InvalidDecisionError(`Duplicate question: ${question.id}`);
      }
      questionIds.add(question.id);
      assertCondition(question, request.questions.slice(0, index));
    });

    const state = await this.states.get(request.stateId);
    assertStateCompatible(state, this.embeddings);
    const stateContext = toDecisionStateContext(state);
    const embedded = await this.embeddingService.embedMany(collectTexts(request.questions));
    let cursor = 0;
    const answers: DecisionAnswer[] = [];
    const snapshots: AuditSnapshot[] = [];

    for (const question of request.questions) {
      const questionVector = embedded[cursor];
      cursor += 1;
      if (!questionVector) {
        throw new EmbeddingProviderError("Missing question embedding.");
      }
      const optionVectors = new Map<string, number[]>();
      if (isChoiceQuestion(question)) {
        for (const option of question.options) {
          const optionVector = embedded[cursor];
          cursor += 1;
          if (!optionVector) {
            throw new EmbeddingProviderError(`Missing embedding for option ${option.id}.`);
          }
          optionVectors.set(option.id, optionVector);
        }
      }

      const retrieved =
        state.knowledge.length === 0
          ? []
          : await this.retrieval.retrieve({
              state,
              questionVector,
              modelId: this.embeddings.modelId,
              thresholds: this.thresholds,
              vectors: this.vectors,
              ...(question.categories === undefined
                ? {}
                : { questionCategories: question.categories }),
            });
      const knowledge = enrichKnowledge(retrieved, state, (event) => this.onDiagnostic?.(event));
      const context: StrategyContext = {
        question,
        questionVector,
        knowledge,
        optionVectors,
        thresholds: this.thresholds,
        state: stateContext,
        modelId: this.embeddings.modelId,
        similarity: cosineMeasure,
      };

      const strategy = this.registry.list().find((item) => item.type === question.type);
      const answer = conditionMet(question, answers)
        ? ensureExplanation(
            this.registry.get(question.type).decide(context),
            context,
            strategy?.version ?? "unversioned",
          )
        : skippedAnswer(
            question,
            state.id,
            state.version,
            this.embeddings.modelId,
            this.thresholds,
            strategy?.version ?? "unversioned",
          );
      answers.push(answer);
      snapshots.push({
        questionId: question.id,
        question,
        questionVector,
        optionVectors: Object.fromEntries(optionVectors),
        knowledge,
        state: stateContext,
        answer,
      });
    }

    return { state, answers, snapshots };
  }
}

function enrichKnowledge(
  items: ScoredKnowledge[],
  state: StateRecord,
  report: (event: PersistenceDiagnostic) => void,
): ScoredKnowledge[] {
  const byId = new Map(state.knowledge.map((item) => [item.id, item]));
  const kept: ScoredKnowledge[] = [];
  for (const item of items) {
    if (item.stateId !== state.id) {
      report({
        kind: "foreign-state",
        stateId: state.id,
        knowledgeId: item.knowledgeId,
        detail: `VectorStore returned knowledge from another State: ${item.stateId}. The item was ignored.`,
      });
      continue;
    }
    const record = byId.get(item.knowledgeId);
    if (!record) {
      report({
        kind: "orphan-vector",
        stateId: state.id,
        knowledgeId: item.knowledgeId,
        detail: `Vector ${item.knowledgeId} has no knowledge in State ${state.id}. The item was ignored.`,
      });
      continue;
    }
    kept.push({
      ...item,
      content: record.content,
      polarity: record.polarity,
      ...knowledgeAttributes(record),
    });
  }
  return kept;
}

function conditionMet(question: DecisionQuestion, answers: DecisionAnswer[]): boolean {
  if (!question.when) {
    return true;
  }
  const previous = answers.find((answer) => answer.questionId === question.when?.questionId);
  return previous !== undefined && question.when.decisions.includes(previous.decision);
}

function skippedAnswer(
  question: DecisionQuestion,
  stateId: string,
  stateVersion: number,
  modelId: string,
  thresholds: DecisionThresholds,
  version: string,
): DecisionAnswer {
  const dependency = question.when;
  const explanation: DecisionExplanation = {
    questionId: question.id,
    question: question.question,
    stateId,
    stateVersion,
    modelId,
    strategy: { type: question.type, version },
    thresholds,
    retrieved: [],
    favorable: [],
    contrary: [],
    conflicts: [],
    calculations: [
      {
        id: "condition",
        strategy: "rules",
        detail: "The question depends on an earlier decision in the same request.",
        values: {
          questionId: dependency?.questionId ?? "",
          decisions: dependency?.decisions.join("|") ?? "",
        },
      },
    ],
    criteria: [
      {
        name: "condition",
        passed: false,
        detail: dependency
          ? `Requires ${dependency.questionId} to be ${dependency.decisions.join(" or ")}.`
          : "Missing condition.",
      },
    ],
    result: "SKIPPED",
    reason: "CONDITION_NOT_MET",
  };
  return {
    questionId: question.id,
    type: question.type,
    decision: "SKIPPED",
    reason: "CONDITION_NOT_MET",
    evidence: [],
    explanation,
  };
}

function ensureExplanation(
  answer: StrategyDecision,
  context: StrategyContext,
  version: string,
): DecisionAnswer {
  return {
    ...answer,
    explanation: answer.explanation ?? {
      questionId: context.question.id,
      question: context.question.question,
      stateId: context.state.id,
      stateVersion: context.state.version,
      modelId: context.modelId,
      strategy: { type: context.question.type, version },
      thresholds: context.thresholds,
      retrieved: [],
      favorable: [],
      contrary: [],
      conflicts: [],
      calculations: [],
      criteria: [],
      result: answer.decision,
      ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    },
  };
}

function sameDecision(left: DecisionAnswer | undefined, right: DecisionAnswer | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  const leftSelected = "selected" in left ? left.selected : undefined;
  const rightSelected = "selected" in right ? right.selected : undefined;
  const leftValue = "value" in left ? left.value : undefined;
  const rightValue = "value" in right ? right.value : undefined;
  return (
    left.questionId === right.questionId &&
    left.decision === right.decision &&
    left.reason === right.reason &&
    leftSelected === rightSelected &&
    leftValue === rightValue
  );
}

function collectTexts(questions: DecisionQuestion[]): string[] {
  const texts: string[] = [];
  for (const question of questions) {
    texts.push(question.question);
    if (isChoiceQuestion(question)) {
      for (const option of question.options) {
        texts.push(option.description);
      }
    }
  }
  return texts;
}

function assertCondition(question: DecisionQuestion, earlier: DecisionQuestion[]): void {
  if (!question.when) {
    return;
  }
  if (!question.when.questionId || question.when.decisions.length === 0) {
    throw new InvalidDecisionError(`The condition on question ${question.id} is incomplete.`);
  }
  if (!earlier.some((item) => item.id === question.when?.questionId)) {
    throw new InvalidDecisionError(
      `Question ${question.id} depends on ${question.when.questionId}, which must appear earlier in the same request.`,
    );
  }
}

function assertQuestion(question: DecisionQuestion): void {
  if (!question.id || question.id.trim().length === 0) {
    throw new InvalidDecisionError("Question is missing an id.");
  }
  if (!question.type || question.type.trim().length === 0) {
    throw new InvalidDecisionError("Question is missing a type.");
  }
  if (!question.question || question.question.trim().length === 0) {
    throw new InvalidDecisionError(`Question ${question.id} is empty.`);
  }
  const polarity = question.polarity as string | undefined;
  if (polarity !== undefined && polarity !== "affirmative" && polarity !== "negative") {
    throw new InvalidDecisionError(
      `Invalid polarity on question ${question.id}. Use affirmative or negative.`,
    );
  }
  if (question.categories !== undefined) {
    for (const category of question.categories) {
      if (!category || category.trim().length === 0) {
        throw new InvalidDecisionError(`Empty category on question ${question.id}.`);
      }
    }
  }

  if (question.type === "choice") {
    const choice = question as ChoiceQuestion;
    if (!Array.isArray(choice.options) || choice.options.length === 0) {
      throw new InvalidDecisionError(`Choice ${question.id} requires at least one option.`);
    }
    const optionIds = new Set<string>();
    for (const option of choice.options) {
      if (!option.id || option.id.trim().length === 0) {
        throw new InvalidDecisionError(`Option on question ${question.id} is missing an id.`);
      }
      if (!option.description || option.description.trim().length === 0) {
        throw new InvalidDecisionError(`Option ${option.id} has no description.`);
      }
      if (optionIds.has(option.id)) {
        throw new InvalidDecisionError(`Duplicate option: ${option.id}`);
      }
      optionIds.add(option.id);
    }
  }

  if (question.type === "score") {
    validateScale("scale" in question ? question.scale : undefined);
  }
}

function assertStateCompatible(state: StateRecord, provider: EmbeddingProvider): void {
  for (const item of state.knowledge) {
    if (item.modelId !== provider.modelId) {
      throw new IncompatibleModelError(provider.modelId, item.modelId);
    }
    if (item.dimensions !== provider.dimensions) {
      throw new IncompatibleDimensionsError(provider.dimensions, item.dimensions);
    }
  }
}

function isChoiceQuestion(question: DecisionQuestion): question is ChoiceQuestion {
  return question.type === "choice";
}
