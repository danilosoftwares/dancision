export type Polarity = "positive" | "negative" | "neutral";

export interface KnowledgeInput {
  id: string;
  content: string;
  polarity: Polarity;
  categories?: string[];
  weight?: number;
  priority?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeRecord {
  id: string;
  content: string;
  polarity: Polarity;
  contentHash: string;
  modelId: string;
  dimensions: number;
  categories?: string[];
  weight?: number;
  priority?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgePatch {
  content?: string;
  polarity?: Polarity;
  categories?: string[];
  weight?: number;
  priority?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export function knowledgeAttributes(
  input: Pick<
    KnowledgeInput,
    "categories" | "weight" | "priority" | "source" | "metadata"
  >,
): Pick<KnowledgeRecord, "categories" | "weight" | "priority" | "source" | "metadata"> {
  return {
    ...(input.categories === undefined ? {} : { categories: input.categories.slice() }),
    ...(input.weight === undefined ? {} : { weight: input.weight }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}
