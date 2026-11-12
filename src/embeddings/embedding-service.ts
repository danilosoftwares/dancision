import type { EmbeddingCache } from "../core/interfaces/embedding-cache.js";
import type { EmbeddingProvider } from "../core/interfaces/embedding-provider.js";
import {
  EmbeddingProviderError,
  InvalidDecisionError,
} from "../core/errors/index.js";
import { embeddingCacheKey } from "../utils/hash.js";
import { assertValidVector } from "../utils/vector.js";

export class EmbeddingService {
  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly cache?: EmbeddingCache,
  ) {}

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedMany([text]);
    if (!vector) {
      throw new EmbeddingProviderError("The provider did not return the embedding.");
    }
    return vector;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const results: Array<number[] | undefined> = new Array(texts.length);
    const missing: string[] = [];
    const missingIndexes = new Map<string, number[]>();

    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index];
      if (text === undefined || text.trim().length === 0) {
        throw new InvalidDecisionError("Empty text for embedding.");
      }

      const key = embeddingCacheKey(this.provider.modelId, text);
      const cached = this.cache ? await this.cache.get(key) : null;
      if (cached) {
        assertValidVector(cached, this.provider.dimensions);
        results[index] = cached.slice();
        continue;
      }

      const indexes = missingIndexes.get(text);
      if (indexes) {
        indexes.push(index);
      } else {
        missingIndexes.set(text, [index]);
        missing.push(text);
      }
    }

    if (missing.length > 0) {
      const embedded = await this.embedUncached(missing);
      if (embedded.length !== missing.length) {
        throw new EmbeddingProviderError(
          "The provider returned a different number of vectors than texts.",
        );
      }

      for (let index = 0; index < missing.length; index += 1) {
        const vector = embedded[index];
        const text = missing[index];
        if (!vector || text === undefined) {
          throw new EmbeddingProviderError("The provider returned an empty embedding.");
        }
        assertValidVector(vector, this.provider.dimensions);
        if (this.cache) {
          await this.cache.set(
            embeddingCacheKey(this.provider.modelId, text),
            vector.slice(),
          );
        }
        for (const target of missingIndexes.get(text) ?? []) {
          results[target] = vector.slice();
        }
      }
    }

    return results.map((vector) => {
      if (!vector) {
        throw new EmbeddingProviderError("Missing embedding for one of the texts.");
      }
      return vector;
    });
  }

  private async embedUncached(texts: string[]): Promise<number[][]> {
    if (this.provider.generateBatch) {
      return this.provider.generateBatch(texts);
    }

    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(await this.provider.generate(text));
    }
    return vectors;
  }
}
