import { describe, expect, it } from "vitest";
import {
  IncompatibleDimensionsError,
  InMemoryVectorStore,
} from "../../src/index.ts";
import type { KnowledgeVector } from "../../src/core/interfaces/vector-store.ts";

function vector(stateId: string, knowledgeId: string, values: number[]): KnowledgeVector {
  return {
    stateId,
    knowledgeId,
    content: knowledgeId,
    polarity: "positive",
    vector: values,
    modelId: "m",
    dimensions: values.length,
    contentHash: knowledgeId,
  };
}

describe("InMemoryVectorStore", () => {
  it("isolates search by State and respects the limit", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert(vector("a", "near", [1, 0, 0, 0]));
    await store.upsert(vector("a", "far", [0, 1, 0, 0]));
    await store.upsert(vector("b", "leak", [1, 0, 0, 0]));

    const found = await store.search({
      stateId: "a",
      vector: [1, 0, 0, 0],
      modelId: "m",
      limit: 1,
    });

    expect(found).toHaveLength(1);
    expect(found[0]?.knowledgeId).toBe("near");
    expect(found[0]?.stateId).toBe("a");
    expect(found[0]?.similarity).toBeCloseTo(1);
  });

  it("removes one knowledge item and the whole State", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert(vector("a", "k1", [1, 0]));
    await store.upsert(vector("a", "k2", [0, 1]));
    await store.delete("a", "k1");
    expect(await store.get("a", "k1")).toBeNull();
    expect(await store.get("a", "k2")).not.toBeNull();

    await store.deleteByState("a");
    expect(await store.get("a", "k2")).toBeNull();
  });

  it("refuses to compare embeddings with different dimensions", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert(vector("a", "k1", [1, 0, 0, 0]));

    await expect(
      store.search({
        stateId: "a",
        vector: [1, 0, 0],
        modelId: "m",
      }),
    ).rejects.toBeInstanceOf(IncompatibleDimensionsError);
  });
});
