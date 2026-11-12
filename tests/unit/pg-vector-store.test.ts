import { describe, expect, it } from "vitest";
import type { PgQueryable } from "../../src/vector-store/pgvector/index.ts";
import {
  createPgPool,
  createPgStores,
} from "../../src/vector-store/pgvector/index.ts";
import { PersistenceError, SchemaMismatchError } from "../../src/index.ts";

class FakeDb implements PgQueryable {
  readonly queries: { sql: string; params?: readonly unknown[] }[] = [];
  relationExists = false;
  typmod: number | null = null;
  searchRows: Record<string, unknown>[] = [];
  stateRows: Record<string, unknown>[] = [];

  async query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    const compact = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (compact.includes("from pg_class")) {
      return { rows: (this.relationExists ? [{ relname: "sde_knowledge" }] : []) as T[] };
    }
    if (compact.includes("atttypmod")) {
      return { rows: (this.typmod === null ? [] : [{ typmod: this.typmod }]) as T[] };
    }
    if (compact.includes("as similarity")) {
      return { rows: this.searchRows as T[] };
    }
    if (compact.includes("_states") && compact.startsWith("select")) {
      return { rows: this.stateRows as T[] };
    }
    return { rows: [] };
  }
}

function sqlOf(db: FakeDb): string {
  return db.queries.map((query) => query.sql).join("\n");
}

describe("PostgreSQL pgvector", () => {
  it("creates the extension, tables, and HNSW index without DROP or a vector column change", async () => {
    const db = new FakeDb();
    const stores = createPgStores(db, { dimensions: 384 });
    db.searchRows = [
      {
        state_id: "salon",
        knowledge_id: "k1",
        content: "The system allows cancelling appointments.",
        polarity: "positive",
        model_id: "model",
        dimensions: 384,
        content_hash: "hash",
        metadata: null,
        embedding: `[${Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)).join(",")}]`,
        similarity: 0.91,
      },
    ];

    const found = await stores.vectors.search({
      stateId: "salon",
      modelId: "model",
      vector: Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)),
      limit: 3,
    });
    const beforeSecond = db.queries.length;
    await stores.vectors.search({
      stateId: "salon",
      modelId: "model",
      vector: Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)),
      limit: 3,
    });

    const sql = sqlOf(db);
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(sql).toContain("vector(384)");
    expect(sql).toContain("USING hnsw (embedding vector_cosine_ops)");
    expect(sql).not.toMatch(/\bdrop\b/i);
    expect(sql).not.toMatch(/\balter\s+column\b/i);
    expect(sql).toContain("ADD COLUMN");
    expect(sql).toContain("state_id = $2");
    expect(sql).toContain("model_id = $3");
    expect(found[0]?.knowledgeId).toBe("k1");
    expect(found[0]?.stateId).toBe("salon");
    expect(found[0]?.similarity).toBeCloseTo(0.91);
    expect(db.queries.length).toBe(beforeSecond + 1);
  });

  it("does not rewrite the column when the existing dimension differs", async () => {
    const db = new FakeDb();
    db.relationExists = true;
    db.typmod = 1536;
    const stores = createPgStores(db, { dimensions: 384 });

    await expect(
      stores.vectors.get("salon", "k1"),
    ).rejects.toBeInstanceOf(SchemaMismatchError);
    const sql = sqlOf(db);
    expect(sql).not.toMatch(/\bdrop\b/i);
    expect(sql).not.toMatch(/\balter\b/i);
    expect(sql).not.toContain("vector(384)");
  });

  it("stores State and knowledge with an idempotent upsert", async () => {
    const db = new FakeDb();
    const stores = createPgStores(db, { dimensions: 4, tablePrefix: "app" });
    await stores.states.save({
      id: "salon",
      name: "Salon",
      categories: [],
      relations: [],
      constraints: [],
      knowledge: [],
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await stores.vectors.upsert({
      stateId: "salon",
      knowledgeId: "k1",
      content: "The system allows cancelling appointments.",
      polarity: "positive",
      vector: [1, 0, 0, 0],
      modelId: "model",
      dimensions: 4,
      contentHash: "hash",
    });

    const sql = sqlOf(db);
    expect(sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(sql).toContain("ON CONFLICT (state_id, knowledge_id) DO UPDATE");
    expect(sql).toContain('"app_states"');
    expect(sql).toContain('"app_knowledge"');
    const vectorQuery = db.queries.find((query) =>
      query.sql.includes("ON CONFLICT (state_id, knowledge_id)"),
    );
    expect(vectorQuery?.params?.[0]).toBe("salon");
    expect(vectorQuery?.params?.[1]).toBe("k1");
  });

  it("rebuilds the State from jsonb", async () => {
    const db = new FakeDb();
    db.stateRows = [
      {
        id: "salon",
        name: "Salon",
        description: null,
        knowledge: JSON.stringify([
          {
            id: "k1",
            content: "text",
            polarity: "positive",
            contentHash: "hash",
            modelId: "model",
            dimensions: 4,
          },
        ]),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const stores = createPgStores(db, { dimensions: 4 });
    const state = await stores.states.get("salon");

    expect(state?.description).toBeUndefined();
    expect(state?.version).toBe(1);
    expect(state?.categories).toEqual([]);
    expect(state?.relations).toEqual([]);
    expect(state?.constraints).toEqual([]);
    expect(state?.knowledge[0]?.id).toBe("k1");
    expect(state?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects an unsafe identifier and an empty connection string", async () => {
    const db = new FakeDb();
    expect(() => createPgStores(db, { dimensions: 4, tablePrefix: "sde-erp" })).toThrow(
      PersistenceError,
    );
    await expect(createPgPool("")).rejects.toBeInstanceOf(PersistenceError);
    await expect(createPgPool("postgres://localhost/dancision")).rejects.toThrow(
      /pg is not installed/,
    );
  });
});
