import type { EmbeddingProvider } from "../../src/core/interfaces/embedding-provider.ts";
import type { DecisionThresholds } from "../../src/core/types/thresholds.ts";
import {
  createInMemoryDecisionEngine,
  type DecisionEngine,
} from "../../src/index.ts";
import { DeterministicEmbeddingProvider } from "../../src/testing/index.ts";

export const thresholds: DecisionThresholds = {
  minSimilarity: 0.72,
  evidenceMargin: 0.05,
  contradictionMargin: 0.05,
  choiceMargin: 0.04,
  topK: 8,
  choiceEvidenceWeight: 0.15,
  aggregation: "sum",
  conflictResolution: "priority",
  relationWeight: 0,
};

export const text = {
  allowCancel: "The system allows cancelling appointments.",
  askCancel: "Can an existing appointment be cancelled?",
  askCancelOtherWords: "May I unbook a booked time slot?",
  askCancelNegated: "Is it not possible to cancel an existing appointment?",
  denyCancel: "The system does not allow cancelling appointments.",
  allowCreate: "The system allows creating appointments.",
  askCreate: "Can an appointment be created?",
  allowUpdate: "The system allows changing appointments.",
  askUpdate: "Can an appointment be changed?",
  denyRecurring: "The system does not allow recurring payments.",
  askRecurring: "Does the system offer recurring payment?",
  unrelated: "What is the capital of France?",
  weakCancel: "Is there a distant mention of time slots?",
  choiceQuestion: "Which scheduling operation is being requested?",
  optionCreate: "Create appointment",
  optionCancel: "Cancel appointment",
  optionUpdate: "Change appointment",
  optionReschedule: "Unbook the time slot",
  supportedCancel: "Cancellation is the supported operation.",
};

export const vector = {
  cancel: [1, 0, 0, 0],
  create: [0, 1, 0, 0],
  update: [0, 0, 1, 0],
  unrelated: [0, 0, 0, 1],
  nearCancel: [0.99, 0.141067, 0, 0],
  weakCancel: [0.6, 0.8, 0, 0],
  choiceCreate: [0.9, 0.43589, 0, 0],
  choiceCancel: [0.86, 0, 0.5103, 0],
  choiceKnowledge: [0.88, 0, 0.475, 0],
};

export function createProvider(
  vectors: Record<string, number[]>,
  modelId = "deterministic-test",
  dimensions = 4,
): DeterministicEmbeddingProvider {
  return new DeterministicEmbeddingProvider({
    dimensions,
    modelId,
    vectors,
  });
}

export function createEngine(
  vectors: Record<string, number[]>,
  options?: {
    modelId?: string;
    thresholds?: Partial<DecisionThresholds>;
    embeddings?: EmbeddingProvider;
  },
): { engine: DecisionEngine; embeddings: EmbeddingProvider } {
  const embeddings =
    options?.embeddings ??
    createProvider(vectors, options?.modelId ?? "deterministic-test");
  const engine = createInMemoryDecisionEngine(embeddings, {
    thresholds: { ...thresholds, ...options?.thresholds },
  });
  return { engine, embeddings };
}

export class SpyProvider implements EmbeddingProvider {
  readonly calls: string[] = [];

  constructor(private readonly inner: EmbeddingProvider) {}

  get modelId(): string {
    return this.inner.modelId;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  async generate(textValue: string): Promise<number[]> {
    this.calls.push(textValue);
    return this.inner.generate(textValue);
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    this.calls.push(...texts);
    if (this.inner.generateBatch) {
      return this.inner.generateBatch(texts);
    }
    const vectors: number[][] = [];
    for (const item of texts) {
      vectors.push(await this.inner.generate(item));
    }
    return vectors;
  }
}
