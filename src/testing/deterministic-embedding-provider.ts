import type { EmbeddingProvider } from "../core/interfaces/embedding-provider.js";
import { EmbeddingProviderError } from "../core/errors/index.js";
import { assertValidVector } from "../utils/vector.js";

export interface DeterministicEmbeddingProviderOptions {
  dimensions: number;
  vectors: Record<string, number[]> | Map<string, number[]>;
  modelId?: string;
  normalizeKey?: (text: string) => string;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly vectors = new Map<string, number[]>();
  private readonly normalizeKey: (text: string) => string;

  constructor(options: DeterministicEmbeddingProviderOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new EmbeddingProviderError("dimensions must be a positive integer.");
    }
    this.dimensions = options.dimensions;
    this.modelId = options.modelId ?? "deterministic-test";
    this.normalizeKey = options.normalizeKey ?? ((text: string) => text);

    const entries =
      options.vectors instanceof Map
        ? options.vectors.entries()
        : Object.entries(options.vectors);
    for (const [text, vector] of entries) {
      this.register(text, vector);
    }
  }

  register(text: string, vector: number[]): void {
    assertValidVector(vector, this.dimensions);
    this.vectors.set(this.normalizeKey(text), vector.slice());
  }

  async generate(text: string): Promise<number[]> {
    const vector = this.vectors.get(this.normalizeKey(text));
    if (!vector) {
      throw new EmbeddingProviderError(
        `No fixture vector for text: ${text}`,
      );
    }
    assertValidVector(vector, this.dimensions);
    return vector.slice();
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(await this.generate(text));
    }
    return vectors;
  }
}
