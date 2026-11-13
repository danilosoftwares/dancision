import { describe, expect, it } from "vitest";
import type { PgQueryable } from "../../src/vector-store/pgvector/index.ts";
import type { StateRepository } from "../../src/core/interfaces/state-repository.ts";
import type { KnowledgeVector, ScoredKnowledge, VectorSearchInput } from "../../src/core/interfaces/vector-store.ts";
import type { PersistenceDiagnostic } from "../../src/index.ts";
import {
  DecisionEngine,
  EmbeddingProviderError,
  InMemoryStateRepository,
  InMemoryVectorStore,
  StateNotFoundError,
  VersionConflictError,
} from "../../src/index.ts";
import { createPgStores } from "../../src/vector-store/pgvector/index.ts";
import { createProvider, text, thresholds, vector } from "../helpers/fixtures.ts";

class PartialVectorStore extends InMemoryVectorStore {
  failAfterWrite = new Set<string>();

  override async upsert(item: KnowledgeVector): Promise<void> {
    await super.upsert(item);
    if (this.failAfterWrite.has(item.knowledgeId)) {
      throw new Error("vector write failed");
    }
  }
}

class FailingStateRepository extends InMemoryStateRepository {
  failInsert = false;
  failDelete = false;

  override async insert(
    state: Parameters<InMemoryStateRepository["insert"]>[0],
  ): Promise<void> {
    if (this.failInsert) {
      throw new Error("state save failed");
    }
    await super.insert(state);
  }

  override async deleteIfVersion(id: string, expectedVersion: number): Promise<boolean> {
    if (this.failDelete) {
      throw new Error("state delete failed");
    }
    return super.deleteIfVersion(id, expectedVersion);
  }
}

class DeletingVectorStore extends InMemoryVectorStore {
  failDelete = false;

  override async deleteByState(stateId: string): Promise<void> {
    await super.deleteByState(stateId);
    if (this.failDelete) {
      throw new Error("vector delete failed");
    }
  }
}

class LeakyVectorStore extends InMemoryVectorStore {
  override async search(input: VectorSearchInput): Promise<ScoredKnowledge[]> {
    const rows = await super.search(input);
    if (input.polarity !== "negative") {
      return rows;
    }
    rows.push({
      stateId: "clinic",
      knowledgeId: "foreign",
      content: "Foreign negative knowledge",
      polarity: "negative",
      similarity: 1,
      vector: input.vector.slice(),
      modelId: input.modelId,
      dimensions: input.vector.length,
      contentHash: "foreign-hash",
    });
    return rows;
  }
}

class TransactionDb implements PgQueryable {
  readonly queries: string[] = [];
  committedStates = 0;
  committedKnowledge = 0;
  failKnowledgeInsert = false;
  private open = false;
  private buffer: string[] = [];

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    this.queries.push(sql);
    const compact = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (compact === "begin") {
      this.open = true;
      this.buffer = [];
      return { rows: [] };
    }
    if (compact === "commit") {
      for (const statement of this.buffer) {
        this.apply(statement);
      }
      this.open = false;
      this.buffer = [];
      return { rows: [] };
    }
    if (compact === "rollback") {
      this.open = false;
      this.buffer = [];
      return { rows: [] };
    }
    if (
      this.failKnowledgeInsert &&
      compact.includes("insert") &&
      compact.includes("sde_knowledge")
    ) {
      throw new Error("vector write failed");
    }
    if (this.open) {
      this.buffer.push(compact);
    } else {
      this.apply(compact);
    }
    if (compact.includes("from pg_class") || compact.includes("atttypmod")) {
      return { rows: [] };
    }
    if (compact.includes("_states") && compact.startsWith("select")) {
      return { rows: [] };
    }
    return { rows: [] };
  }

  private apply(sql: string): void {
    if (sql.includes("insert") && sql.includes("sde_states")) {
      this.committedStates += 1;
    }
    if (sql.includes("insert") && sql.includes("sde_knowledge")) {
      this.committedKnowledge += 1;
    }
  }
}

function holdReads(inner: InMemoryStateRepository, count: number): {
  repository: StateRepository;
  arm: () => void;
  release: () => void;
  ready: () => Promise<void>;
} {
  let armed = false;
  let seen = 0;
  let release = (): void => {};
  let barrier = Promise.resolve();
  let ready = Promise.resolve();
  let markReady = (): void => {};
  const repository: StateRepository = {
    get: async (id, session) => {
      const value = await inner.get(id, session);
      if (!armed) {
        return value;
      }
      seen += 1;
      if (seen === count) {
        markReady();
      }
      if (seen <= count) {
        await barrier;
      }
      return value;
    },
    save: (state, session) => inner.save(state, session),
    insert: (state, session) => inner.insert(state, session),
    compareAndSave: (state, expectedVersion, session) =>
      inner.compareAndSave(state, expectedVersion, session),
    delete: (id, session) => inner.delete(id, session),
    deleteIfVersion: (id, expectedVersion, session) =>
      inner.deleteIfVersion(id, expectedVersion, session),
  };
  return {
    repository,
    arm() {
      armed = true;
      seen = 0;
      ready = new Promise((resolve) => {
        markReady = resolve;
      });
      barrier = new Promise((resolve) => {
        release = resolve;
      });
    },
    release() {
      release();
    },
    ready: () => ready,
  };
}

describe("persistence consistency", () => {
  it("leaves nothing behind when the State save fails", async () => {
    const states = new FailingStateRepository();
    states.failInsert = true;
    const vectors = new InMemoryVectorStore();
    const engine = new DecisionEngine({
      embeddings: createProvider({ [text.allowCancel]: vector.cancel }),
      vectors,
      states,
      thresholds,
    });

    await expect(
      engine.states.create({
        id: "salon",
        name: "Salon",
        knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      }),
    ).rejects.toThrow("state save failed");
    await expect(engine.states.get("salon")).rejects.toBeInstanceOf(StateNotFoundError);
    expect(await vectors.get("salon", "k1")).toBeNull();
  });

  it("leaves nothing behind when embedding generation fails", async () => {
    const states = new InMemoryStateRepository();
    const vectors = new InMemoryVectorStore();
    const engine = new DecisionEngine({
      embeddings: createProvider({}),
      vectors,
      states,
      thresholds,
    });

    await expect(
      engine.states.create({
        id: "salon",
        name: "Salon",
        knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      }),
    ).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(engine.states.get("salon")).rejects.toBeInstanceOf(StateNotFoundError);
    expect(await vectors.get("salon", "k1")).toBeNull();
  });

  it.each([
    ["the first vector", "k1"],
    ["an intermediate vector", "k2"],
    ["the last vector", "k3"],
  ])("removes the partial State when %s fails", async (_label, failingId) => {
    const vectors = new PartialVectorStore();
    vectors.failAfterWrite.add(failingId);
    const states = new InMemoryStateRepository();
    const engine = new DecisionEngine({
      embeddings: createProvider({
        [text.allowCancel]: vector.cancel,
        [text.allowCreate]: vector.create,
        [text.allowUpdate]: vector.update,
      }),
      vectors,
      states,
      thresholds,
    });

    await expect(
      engine.states.create({
        id: "salon",
        name: "Salon",
        knowledge: [
          { id: "k1", content: text.allowCancel, polarity: "positive" },
          { id: "k2", content: text.allowCreate, polarity: "positive" },
          { id: "k3", content: text.allowUpdate, polarity: "positive" },
        ],
      }),
    ).rejects.toThrow("vector write failed");
    await expect(engine.states.get("salon")).rejects.toBeInstanceOf(StateNotFoundError);
    expect(await vectors.get("salon", "k1")).toBeNull();
    expect(await vectors.get("salon", "k2")).toBeNull();
    expect(await vectors.get("salon", "k3")).toBeNull();
  });

  it("keeps the State when vector deletion fails", async () => {
    const vectors = new DeletingVectorStore();
    const states = new InMemoryStateRepository();
    const engine = new DecisionEngine({
      embeddings: createProvider({ [text.allowCancel]: vector.cancel }),
      vectors,
      states,
      thresholds,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });
    vectors.failDelete = true;

    await expect(engine.states.delete("salon")).rejects.toThrow("vector delete failed");
    expect((await engine.states.get("salon")).knowledge.map((item) => item.id)).toEqual(["k1"]);
    expect(await vectors.get("salon", "k1")).not.toBeNull();
  });

  it("keeps vectors when State deletion fails", async () => {
    const vectors = new InMemoryVectorStore();
    const states = new FailingStateRepository();
    const engine = new DecisionEngine({
      embeddings: createProvider({ [text.allowCancel]: vector.cancel }),
      vectors,
      states,
      thresholds,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });
    states.failDelete = true;

    await expect(engine.states.delete("salon")).rejects.toThrow("state delete failed");
    expect((await engine.states.get("salon")).knowledge).toHaveLength(1);
    expect(await vectors.get("salon", "k1")).not.toBeNull();
  });

  it("treats a missing or repeated delete as a completed operation", async () => {
    const vectors = new InMemoryVectorStore();
    const engine = new DecisionEngine({
      embeddings: createProvider({ [text.allowCancel]: vector.cancel }),
      vectors,
      states: new InMemoryStateRepository(),
      thresholds,
    });
    await engine.states.delete("missing");
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });

    await engine.states.delete("salon");
    await engine.states.delete("salon");
    await expect(engine.states.get("salon")).rejects.toBeInstanceOf(StateNotFoundError);
    expect(await vectors.get("salon", "k1")).toBeNull();
  });

  it("rejects the losing concurrent knowledge insert and keeps both after a retry", async () => {
    const inner = new InMemoryStateRepository();
    const gate = holdReads(inner, 2);
    const engine = new DecisionEngine({
      embeddings: createProvider({
        [text.allowCancel]: vector.cancel,
        [text.allowCreate]: vector.create,
      }),
      vectors: new InMemoryVectorStore(),
      states: gate.repository,
      thresholds,
    });
    await engine.states.create({ id: "salon", name: "Salon" });
    gate.arm();

    const first = engine.states.addKnowledge("salon", {
      id: "k-a",
      content: text.allowCancel,
      polarity: "positive",
    });
    const second = engine.states.addKnowledge("salon", {
      id: "k-b",
      content: text.allowCreate,
      polarity: "positive",
    });
    await gate.ready();
    gate.release();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(VersionConflictError);
    await engine.states.addKnowledge("salon", {
      id: "k-a",
      content: text.allowCancel,
      polarity: "positive",
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("already exists")) {
        throw error;
      }
    });
    await engine.states.addKnowledge("salon", {
      id: "k-b",
      content: text.allowCreate,
      polarity: "positive",
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("already exists")) {
        throw error;
      }
    });

    const state = await engine.states.get("salon");
    expect(state.knowledge.map((item) => item.id).sort()).toEqual(["k-a", "k-b"]);
  });

  it("does not let a concurrent delete erase an update that won the version", async () => {
    const inner = new InMemoryStateRepository();
    const gate = holdReads(inner, 2);
    const engine = new DecisionEngine({
      embeddings: createProvider({ [text.allowCancel]: vector.cancel }),
      vectors: new InMemoryVectorStore(),
      states: gate.repository,
      thresholds,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });
    gate.arm();
    const update = engine.states.update("salon", { name: "Renamed" });
    const deletion = engine.states.delete("salon");
    await gate.ready();
    gate.release();

    await update;
    await expect(deletion).rejects.toBeInstanceOf(VersionConflictError);
    expect((await engine.states.get("salon")).name).toBe("Renamed");
  });

  it("does not let a concurrent update recreate a State that was deleted", async () => {
    const inner = new InMemoryStateRepository();
    const gate = holdReads(inner, 2);
    const engine = new DecisionEngine({
      embeddings: createProvider({ [text.allowCancel]: vector.cancel }),
      vectors: new InMemoryVectorStore(),
      states: gate.repository,
      thresholds,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });
    gate.arm();
    const deletion = engine.states.delete("salon");
    const update = engine.states.update("salon", { name: "Renamed" });
    await gate.ready();
    gate.release();

    await deletion;
    await expect(update).rejects.toBeInstanceOf(VersionConflictError);
    await expect(engine.states.get("salon")).rejects.toBeInstanceOf(StateNotFoundError);
  });

  it("ignores an orphan vector and knowledge from another State", async () => {
    const diagnostics: PersistenceDiagnostic[] = [];
    const vectors = new LeakyVectorStore();
    const engine = new DecisionEngine({
      embeddings: createProvider({
        [text.allowCancel]: vector.cancel,
        [text.denyCancel]: vector.nearCancel,
        [text.askCancel]: vector.cancel,
      }),
      vectors,
      states: new InMemoryStateRepository(),
      thresholds: { ...thresholds, topK: 1 },
      onDiagnostic(event) {
        diagnostics.push(event);
      },
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [
        { id: "keep", content: text.allowCancel, polarity: "positive" },
        { id: "gone", content: text.denyCancel, polarity: "negative" },
      ],
    });
    const orphan = await vectors.get("salon", "gone");
    await engine.states.removeKnowledge("salon", "gone");
    if (!orphan) {
      throw new Error("missing stored vector");
    }
    await vectors.upsert(orphan);

    const result = await engine.decide({
      stateId: "salon",
      questions: [{ id: "q", type: "noul", question: text.askCancel }],
    });

    expect(result.answers[0]?.decision).toBe("YES");
    expect(result.answers[0]?.evidence.map((item) => item.knowledgeId)).toEqual(["keep"]);
    expect(diagnostics.map((event) => event.kind).sort()).toEqual(["foreign-state", "orphan-vector"]);
    expect(diagnostics.find((event) => event.kind === "orphan-vector")?.knowledgeId).toBe("gone");
    expect(diagnostics.find((event) => event.kind === "foreign-state")?.detail).toContain("clinic");
  });

  it("retrieves contrary evidence that a single topK window would hide", async () => {
    const positives = ["positive-a", "positive-b", "positive-c"];
    const negative = "negative-evidence";
    const question = "which side is supported";
    const planted: Record<string, number[]> = {
      [question]: vector.cancel,
      [negative]: [0.8, 0.6, 0, 0],
    };
    for (const item of positives) {
      planted[item] = vector.cancel;
    }
    const engine = new DecisionEngine({
      embeddings: createProvider(planted),
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      thresholds: { ...thresholds, topK: 2 },
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [
        ...positives.map((content, index) => ({
          id: `yes-${index}`,
          content,
          polarity: "positive" as const,
        })),
        { id: "no-1", content: negative, polarity: "negative" as const },
      ],
    });

    const result = await engine.decide({
      stateId: "salon",
      questions: [{ id: "q", type: "noul", question }],
    });

    expect(result.answers[0]?.decision).toBe("UNDETERMINED");
    expect(result.answers[0]?.reason).toBe("CONTRADICTORY");
    expect(result.answers[0]?.evidence.map((item) => item.knowledgeId)).toContain("no-1");
  });

  it("retrieves the category match that a global positive window would hide", async () => {
    const fillers = ["schedule-a", "schedule-b"];
    const billing = "billing evidence";
    const question = "billing question";
    const planted: Record<string, number[]> = {
      [question]: vector.cancel,
      [billing]: [0.8, 0.6, 0, 0],
    };
    for (const item of fillers) {
      planted[item] = vector.cancel;
    }
    const engine = new DecisionEngine({
      embeddings: createProvider(planted),
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      thresholds: { ...thresholds, topK: 2 },
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [
        ...fillers.map((content, index) => ({
          id: `fill-${index}`,
          content,
          polarity: "positive" as const,
          categories: ["scheduling"],
        })),
        {
          id: "bill",
          content: billing,
          polarity: "positive" as const,
          categories: ["billing"],
        },
      ],
    });

    const result = await engine.decide({
      stateId: "salon",
      questions: [
        { id: "q", type: "noul", question, categories: ["billing"] },
      ],
    });

    expect(result.answers[0]?.decision).toBe("YES");
    expect(result.answers[0]?.evidence.map((item) => item.knowledgeId)).toEqual(["bill"]);
  });

  it("uses a custom retrieval strategy when one is provided", async () => {
    const engine = new DecisionEngine({
      embeddings: createProvider({
        [text.allowCancel]: vector.cancel,
        [text.askCancel]: vector.cancel,
      }),
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      thresholds,
      retrieval: { async retrieve() { return []; } },
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });

    const result = await engine.decide({
      stateId: "salon",
      questions: [{ id: "q", type: "noul", question: text.askCancel }],
    });

    expect(result.answers[0]?.decision).toBe("UNDETERMINED");
    expect(result.answers[0]?.reason).toBe("NO_EVIDENCE");
  });

  it("commits State and vectors together and rolls both back when a vector insert fails", async () => {
    const db = new TransactionDb();
    const stores = createPgStores(db, { dimensions: 4 });
    const embeddings = createProvider({
      [text.allowCancel]: vector.cancel,
      [text.allowCreate]: vector.create,
    });
    const engine = new DecisionEngine({
      embeddings,
      vectors: stores.vectors,
      states: stores.states,
      thresholds,
    });

    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [
        { id: "k1", content: text.allowCancel, polarity: "positive" },
        { id: "k2", content: text.allowCreate, polarity: "positive" },
      ],
    });
    expect(db.committedStates).toBe(1);
    expect(db.committedKnowledge).toBe(2);
    expect(db.queries.some((sql) => sql.trim().toUpperCase() === "BEGIN")).toBe(true);
    expect(db.queries.some((sql) => sql.includes("AND version ="))).toBe(false);

    db.failKnowledgeInsert = true;
    await expect(
      engine.states.create({
        id: "other",
        name: "Other",
        knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      }),
    ).rejects.toThrow("vector write failed");
    expect(db.committedStates).toBe(1);
    expect(db.committedKnowledge).toBe(2);
    expect(db.queries.some((sql) => sql.trim().toUpperCase() === "ROLLBACK")).toBe(true);
  });
});
