import type { EmbeddingCache } from "../core/interfaces/embedding-cache.js";
import { InvalidDecisionError } from "../core/errors/index.js";

export class InMemoryEmbeddingCache implements EmbeddingCache {
  private readonly entries = new Map<string, number[]>();

  constructor(private readonly maxEntries = 500) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new InvalidDecisionError(
        "Cache maxEntries must be a positive integer.",
      );
    }
  }

  get(key: string): number[] | null {
    const value = this.entries.get(key);
    if (!value) {
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    return value.slice();
  }

  set(key: string, vector: number[]): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, vector.slice());
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}
