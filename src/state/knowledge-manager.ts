import type { EmbeddingProvider } from "../core/interfaces/embedding-provider.js";
import type { KnowledgeVector } from "../core/interfaces/vector-store.js";
import { EmbeddingProviderError } from "../core/errors/index.js";
import type { KnowledgeInput, KnowledgeRecord } from "../core/types/knowledge.js";
import { knowledgeAttributes } from "../core/types/knowledge.js";
import { EmbeddingService } from "../embeddings/embedding-service.js";
import { hashContent } from "../utils/hash.js";
import { validateKnowledgeList } from "../utils/validation.js";

export interface IndexedKnowledge {
  records: KnowledgeRecord[];
  vectors: KnowledgeVector[];
}

export class KnowledgeManager {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly provider: EmbeddingProvider,
  ) {}

  async embedAll(stateId: string, inputs: KnowledgeInput[]): Promise<IndexedKnowledge> {
    validateKnowledgeList(inputs);
    if (inputs.length === 0) {
      return { records: [], vectors: [] };
    }

    const embedded = await this.embeddings.embedMany(inputs.map((item) => item.content));
    const records: KnowledgeRecord[] = [];
    const vectors: KnowledgeVector[] = [];

    for (let index = 0; index < inputs.length; index += 1) {
      const item = inputs[index];
      const vector = embedded[index];
      if (!item || !vector) {
        throw new EmbeddingProviderError(
          "Missing embedding for one of the knowledge items.",
        );
      }
      const contentHash = hashContent(item.content);
      records.push({
        id: item.id,
        content: item.content,
        polarity: item.polarity,
        contentHash,
        modelId: this.provider.modelId,
        dimensions: this.provider.dimensions,
        ...knowledgeAttributes(item),
      });
      vectors.push({
        stateId,
        knowledgeId: item.id,
        content: item.content,
        polarity: item.polarity,
        vector,
        modelId: this.provider.modelId,
        dimensions: this.provider.dimensions,
        contentHash,
        ...knowledgeAttributes(item),
      });
    }

    return { records, vectors };
  }
}
