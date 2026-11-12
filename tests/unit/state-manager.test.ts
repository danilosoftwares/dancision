import { describe, expect, it } from "vitest";
import type { VectorStore } from "../../src/core/interfaces/vector-store.ts";
import {
  DecisionEngine,
  DuplicateStateError,
  InMemoryStateRepository,
  InMemoryVectorStore,
  KnowledgeNotFoundError,
  StateNotFoundError,
} from "../../src/index.ts";
import { createProvider, text, thresholds, vector } from "../helpers/fixtures.ts";

class FailingVectorStore extends InMemoryVectorStore implements VectorStore {
  failWrites = false;

  override async upsert(
    item: Parameters<InMemoryVectorStore["upsert"]>[0],
  ): Promise<void> {
    if (this.failWrites) {
      throw new Error("vector write failed");
    }
    await super.upsert(item);
  }

  override async upsertMany(
    items: Parameters<InMemoryVectorStore["upsertMany"]>[0],
  ): Promise<void> {
    if (this.failWrites) {
      throw new Error("vector write failed");
    }
    await super.upsertMany(items);
  }
}

describe("StateManager", () => {
  it("creates, reads, and isolates mutation of the returned object", async () => {
    const embeddings = createProvider({
      [text.allowCancel]: vector.cancel,
    });
    const engine = new DecisionEngine({
      embeddings,
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      thresholds,
    });

    await engine.states.create({
      id: "salon",
      name: "Salon",
      description: "Management",
      knowledge: [
        { id: "k1", content: text.allowCancel, polarity: "positive" },
      ],
    });

    const first = await engine.states.get("salon");
    const knowledge = first.knowledge[0];
    if (!knowledge) {
      throw new Error("missing knowledge");
    }
    knowledge.content = "mutated by the caller";

    const second = await engine.states.get("salon");
    expect(second.knowledge[0]?.content).toBe(text.allowCancel);
    expect(second.knowledge[0]?.contentHash).toHaveLength(64);
    expect(second.knowledge[0]?.modelId).toBe("deterministic-test");
  });

  it("rejects a duplicate State and missing knowledge", async () => {
    const embeddings = createProvider({
      [text.allowCancel]: vector.cancel,
    });
    const engine = new DecisionEngine({
      embeddings,
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      thresholds,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });

    await expect(
      engine.states.create({ id: "salon", name: "Other" }),
    ).rejects.toBeInstanceOf(DuplicateStateError);
    await expect(
      engine.states.removeKnowledge("salon", "missing"),
    ).rejects.toBeInstanceOf(KnowledgeNotFoundError);
    await expect(engine.states.get("other")).rejects.toBeInstanceOf(StateNotFoundError);
  });

  it("rolls back the State when the vector write fails", async () => {
    const embeddings = createProvider({
      [text.allowCancel]: vector.cancel,
    });
    const vectors = new FailingVectorStore();
    vectors.failWrites = true;
    const engine = new DecisionEngine({
      embeddings,
      vectors,
      states: new InMemoryStateRepository(),
      thresholds,
    });

    await expect(
      engine.states.create({
        id: "salon",
        name: "Salon",
        knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      }),
    ).rejects.toThrow("vector write failed");
    await expect(engine.states.get("salon")).rejects.toBeInstanceOf(StateNotFoundError);
  });

  it("adds and removes knowledge", async () => {
    const embeddings = createProvider({
      [text.allowCancel]: vector.cancel,
      [text.allowCreate]: vector.create,
    });
    const engine = new DecisionEngine({
      embeddings,
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      thresholds,
    });
    await engine.states.create({ id: "salon", name: "Salon" });
    await engine.states.addKnowledge("salon", {
      id: "k1",
      content: text.allowCancel,
      polarity: "positive",
    });
    await engine.states.addKnowledge("salon", {
      id: "k2",
      content: text.allowCreate,
      polarity: "positive",
    });
    const removed = await engine.states.removeKnowledge("salon", "k1");
    expect(removed.knowledge.map((item) => item.id)).toEqual(["k2"]);
  });
});
