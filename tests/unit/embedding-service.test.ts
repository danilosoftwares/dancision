import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../../src/core/interfaces/embedding-provider.ts";
import {
  EmbeddingService,
  InMemoryEmbeddingCache,
  IncompatibleDimensionsError,
  InvalidVectorError,
} from "../../src/index.ts";

class TableProvider implements EmbeddingProvider {
  readonly modelId = "table";
  readonly dimensions = 2;
  readonly calls: string[] = [];

  constructor(private readonly vectors: Record<string, number[]>) {}

  async generate(text: string): Promise<number[]> {
    this.calls.push(text);
    const vector = this.vectors[text];
    if (!vector) {
      throw new Error(`missing: ${text}`);
    }
    return vector.slice();
  }
}

describe("EmbeddingService", () => {
  it("deduplicates identical texts in the same batch", async () => {
    const provider = new TableProvider({
      alpha: [1, 0],
      beta: [0, 1],
    });
    const service = new EmbeddingService(provider);

    const vectors = await service.embedMany(["alpha", "beta", "alpha"]);

    expect(provider.calls).toEqual(["alpha", "beta"]);
    expect(vectors[0]).toEqual([1, 0]);
    expect(vectors[2]).toEqual([1, 0]);
    expect(vectors[0]).not.toBe(vectors[2]);
  });

  it("reuses the cache across calls", async () => {
    const provider = new TableProvider({ alpha: [1, 0] });
    const service = new EmbeddingService(provider, new InMemoryEmbeddingCache());

    await service.embed("alpha");
    await service.embed("alpha");

    expect(provider.calls).toEqual(["alpha"]);
  });

  it("calls generate sequentially when there is no batch method", async () => {
    const provider = new TableProvider({
      alpha: [1, 0],
      beta: [0, 1],
    });
    const service = new EmbeddingService(provider);

    await service.embedMany(["alpha", "beta"]);

    expect(provider.calls).toEqual(["alpha", "beta"]);
  });

  it("rejects a vector whose dimension differs from the declared size", async () => {
    const provider = new TableProvider({ alpha: [1, 0, 0] });
    const service = new EmbeddingService(provider);

    await expect(service.embed("alpha")).rejects.toBeInstanceOf(IncompatibleDimensionsError);
  });

  it("rejects a zero vector", async () => {
    const provider = new TableProvider({ alpha: [0, 0] });
    const service = new EmbeddingService(provider);

    await expect(service.embed("alpha")).rejects.toThrow(InvalidVectorError);
  });
});
