import type {
  KnowledgeVector,
  ScoredKnowledge,
  VectorSearchInput,
  VectorStore,
} from "../../core/interfaces/vector-store.js";
import {
  IncompatibleDimensionsError,
  InvalidDecisionError,
  PersistenceError,
} from "../../core/errors/index.js";
import { pgTableNames, qualify, type PgQueryable, type PgSchemaConfig } from "./identifiers.js";
import { assertPolarity, assertValidVector, parseVectorLiteral, toVectorLiteral } from "../../utils/vector.js";

interface KnowledgeRow {
  state_id: string;
  knowledge_id: string;
  content: string;
  polarity: string;
  model_id: string;
  dimensions: number | string;
  content_hash: string;
  metadata: Record<string, unknown> | null;
  embedding: unknown;
  similarity?: number | string;
}

export class PgVectorStore implements VectorStore {
  private readonly table: string;
  private readonly dimensions: number;

  constructor(
    private readonly db: PgQueryable,
    config: PgSchemaConfig,
    private readonly ready: () => Promise<void>,
  ) {
    this.table = qualify(config.schema, pgTableNames(config).knowledge);
    this.dimensions = config.dimensions;
  }

  async upsert(vector: KnowledgeVector): Promise<void> {
    await this.ready();
    this.assertStorable(vector);
    await this.db.query(
      `
        INSERT INTO ${this.table} (
          state_id,
          knowledge_id,
          content,
          polarity,
          embedding,
          model_id,
          dimensions,
          content_hash,
          metadata
        ) VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9::jsonb)
        ON CONFLICT (state_id, knowledge_id) DO UPDATE SET
          content = EXCLUDED.content,
          polarity = EXCLUDED.polarity,
          embedding = EXCLUDED.embedding,
          model_id = EXCLUDED.model_id,
          dimensions = EXCLUDED.dimensions,
          content_hash = EXCLUDED.content_hash,
          metadata = EXCLUDED.metadata
      `,
      [
        vector.stateId,
        vector.knowledgeId,
        vector.content,
        vector.polarity,
        toVectorLiteral(vector.vector),
        vector.modelId,
        vector.dimensions,
        vector.contentHash,
        vector.metadata === undefined ? null : JSON.stringify(vector.metadata),
      ],
    );
  }

  async upsertMany(vectors: KnowledgeVector[]): Promise<void> {
    for (const vector of vectors) {
      this.assertStorable(vector);
    }
    for (const vector of vectors) {
      await this.upsert(vector);
    }
  }

  async search(input: VectorSearchInput): Promise<ScoredKnowledge[]> {
    await this.ready();
    assertSearch(input);
    if (input.vector.length !== this.dimensions) {
      throw new IncompatibleDimensionsError(this.dimensions, input.vector.length);
    }

    const params: unknown[] = [
      toVectorLiteral(input.vector),
      input.stateId,
      input.modelId,
    ];
    let limitSql = "";
    if (input.limit !== undefined) {
      params.push(input.limit);
      limitSql = `LIMIT $${params.length}`;
    }

    const result = await this.db.query<KnowledgeRow>(
      `
        SELECT
          state_id,
          knowledge_id,
          content,
          polarity,
          model_id,
          dimensions,
          content_hash,
          metadata,
          embedding::text AS embedding,
          1 - (embedding <=> $1::vector) AS similarity
        FROM ${this.table}
        WHERE state_id = $2
          AND model_id = $3
        ORDER BY embedding <=> $1::vector, knowledge_id ASC
        ${limitSql}
      `,
      params,
    );

    return result.rows.map((row) => this.mapScored(row));
  }

  async get(stateId: string, knowledgeId: string): Promise<KnowledgeVector | null> {
    await this.ready();
    const result = await this.db.query<KnowledgeRow>(
      `
        SELECT
          state_id,
          knowledge_id,
          content,
          polarity,
          model_id,
          dimensions,
          content_hash,
          metadata,
          embedding::text AS embedding
        FROM ${this.table}
        WHERE state_id = $1 AND knowledge_id = $2
      `,
      [stateId, knowledgeId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return this.mapVector(row);
  }

  async delete(stateId: string, knowledgeId: string): Promise<void> {
    await this.ready();
    await this.db.query(
      `DELETE FROM ${this.table} WHERE state_id = $1 AND knowledge_id = $2`,
      [stateId, knowledgeId],
    );
  }

  async deleteByState(stateId: string): Promise<void> {
    await this.ready();
    await this.db.query(`DELETE FROM ${this.table} WHERE state_id = $1`, [stateId]);
  }

  private assertStorable(vector: KnowledgeVector): void {
    if (vector.vector.length !== this.dimensions || vector.dimensions !== this.dimensions) {
      throw new IncompatibleDimensionsError(this.dimensions, vector.vector.length);
    }
    assertPolarity(vector.polarity);
    assertValidVector(vector.vector, this.dimensions);
    if (!vector.stateId.trim() || !vector.knowledgeId.trim() || !vector.modelId.trim()) {
      throw new InvalidDecisionError("Vector is missing stateId, knowledgeId, or modelId.");
    }
  }

  private mapScored(row: KnowledgeRow): ScoredKnowledge {
    const vector = this.mapVector(row);
    const similarity = Number(row.similarity);
    if (!Number.isFinite(similarity)) {
      throw new PersistenceError("Invalid similarity returned by Postgres.");
    }
    return {
      ...vector,
      similarity,
    };
  }

  private mapVector(row: KnowledgeRow): KnowledgeVector {
    assertPolarity(row.polarity);
    const vector = parseVectorLiteral(row.embedding);
    const dimensions = Number(row.dimensions);
    if (vector.length !== this.dimensions) {
      throw new IncompatibleDimensionsError(this.dimensions, vector.length);
    }
    return {
      stateId: row.state_id,
      knowledgeId: row.knowledge_id,
      content: row.content,
      polarity: row.polarity,
      vector,
      modelId: row.model_id,
      dimensions,
      contentHash: row.content_hash,
      ...(row.metadata === null || row.metadata === undefined
        ? {}
        : { metadata: row.metadata }),
    };
  }
}

function assertSearch(input: VectorSearchInput): void {
  if (!input.stateId.trim() || !input.modelId.trim()) {
    throw new InvalidDecisionError("Search is missing a stateId or modelId.");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new InvalidDecisionError("Search limit must be a positive integer.");
  }
}
