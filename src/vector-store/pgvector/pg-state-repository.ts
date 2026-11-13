import type { StateRepository } from "../../core/interfaces/state-repository.js";
import { DuplicateStateError, PersistenceError } from "../../core/errors/index.js";
import type { PersistenceSession } from "../../core/persistence/transaction.js";
import type { KnowledgeRecord } from "../../core/types/knowledge.js";
import type { KnowledgeRelation, StateConstraint, StateRecord } from "../../core/types/state.js";
import { pgTableNames, qualify, type PgQueryable, type PgSchemaConfig } from "./identifiers.js";
import { PgTransactionCoordinator } from "./pg-transaction.js";

interface StateRow {
  id: string;
  name: string;
  description: string | null;
  domain?: string | null;
  metadata?: unknown;
  categories?: unknown;
  relations?: unknown;
  constraints?: unknown;
  knowledge: KnowledgeRecord[] | string;
  version?: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PgStateRepository implements StateRepository {
  private readonly table: string;

  constructor(
    _db: PgQueryable,
    config: PgSchemaConfig,
    private readonly ready: () => Promise<void>,
    private readonly transactions: PgTransactionCoordinator,
  ) {
    this.table = qualify(config.schema, pgTableNames(config).states);
  }

  get transactionKey(): string {
    return this.transactions.transactionKey;
  }

  runInTransaction<T>(work: (session: PersistenceSession) => Promise<T>): Promise<T> {
    return this.transactions.runInTransaction(work);
  }

  async save(state: StateRecord, session?: PersistenceSession): Promise<void> {
    await this.ready();
    await this.query(session)(
      `
        INSERT INTO ${this.table} (
          id, name, description, domain, metadata, categories, relations, constraints,
          knowledge, version, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
          $9::jsonb, $10, $11, $12
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          domain = EXCLUDED.domain,
          metadata = EXCLUDED.metadata,
          categories = EXCLUDED.categories,
          relations = EXCLUDED.relations,
          constraints = EXCLUDED.constraints,
          knowledge = EXCLUDED.knowledge,
          version = EXCLUDED.version,
          updated_at = EXCLUDED.updated_at
      `,
      stateParams(state),
    );
  }

  async insert(state: StateRecord, session?: PersistenceSession): Promise<void> {
    await this.ready();
    try {
      await this.query(session)(
        `
          INSERT INTO ${this.table} (
            id, name, description, domain, metadata, categories, relations, constraints,
            knowledge, version, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
            $9::jsonb, $10, $11, $12
          )
        `,
        stateParams(state),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateStateError(state.id);
      }
      throw error;
    }
  }

  async compareAndSave(
    state: StateRecord,
    expectedVersion: number,
    session?: PersistenceSession,
  ): Promise<boolean> {
    await this.ready();
    const result = await this.query(session)<{ id: string }>(
      `
        UPDATE ${this.table} SET
          name = $2,
          description = $3,
          domain = $4,
          metadata = $5::jsonb,
          categories = $6::jsonb,
          relations = $7::jsonb,
          constraints = $8::jsonb,
          knowledge = $9::jsonb,
          version = $10,
          created_at = $11,
          updated_at = $12
        WHERE id = $1 AND version = $13
        RETURNING id
      `,
      [...stateParams(state), expectedVersion],
    );
    return result.rows.length > 0;
  }

  async get(id: string, session?: PersistenceSession): Promise<StateRecord | null> {
    await this.ready();
    const result = await this.query(session)<StateRow>(
      `
        SELECT
          id, name, description, domain, metadata, categories, relations, constraints,
          knowledge, version, created_at, updated_at
        FROM ${this.table}
        WHERE id = $1
      `,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return mapState(row);
  }

  async delete(id: string, session?: PersistenceSession): Promise<void> {
    await this.ready();
    await this.query(session)(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  async deleteIfVersion(
    id: string,
    expectedVersion: number,
    session?: PersistenceSession,
  ): Promise<boolean> {
    await this.ready();
    const result = await this.query(session)<{ id: string }>(
      `DELETE FROM ${this.table} WHERE id = $1 AND version = $2 RETURNING id`,
      [id, expectedVersion],
    );
    return result.rows.length > 0;
  }

  private query(session?: PersistenceSession): PgQueryable["query"] {
    return this.transactions.queryFor(session);
  }
}

function stateParams(state: StateRecord): unknown[] {
  return [
    state.id,
    state.name,
    state.description ?? null,
    state.domain ?? null,
    state.metadata === undefined ? null : JSON.stringify(state.metadata),
    JSON.stringify(state.categories ?? []),
    JSON.stringify(state.relations ?? []),
    JSON.stringify(state.constraints ?? []),
    JSON.stringify(state.knowledge),
    Number.isInteger(state.version) ? state.version : 1,
    state.createdAt,
    state.updatedAt,
  ];
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function mapState(row: StateRow): StateRecord {
  const description = blankToUndefined(row.description);
  const domain = blankToUndefined(row.domain);
  const metadata = readObject(row.metadata);
  const version = Number(row.version);
  return {
    id: row.id,
    name: row.name,
    ...(description === undefined ? {} : { description }),
    ...(domain === undefined ? {} : { domain }),
    ...(metadata === undefined ? {} : { metadata }),
    categories: readStringList(row.categories),
    relations: readList<KnowledgeRelation>(row.relations),
    constraints: readList<StateConstraint>(row.constraints),
    knowledge: readKnowledge(row.knowledge),
    version: Number.isInteger(version) ? version : 1,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function blankToUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function readStringList(value: unknown): string[] {
  return readList<string>(value).filter((item) => typeof item === "string");
}

function readList<T>(value: unknown): T[] {
  if (value === null || value === undefined) {
    return [];
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new PersistenceError("Structured State column is not a list.");
  }
  return parsed as T[];
}

function readKnowledge(value: KnowledgeRecord[] | string): KnowledgeRecord[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new PersistenceError("The State knowledge column is not a list.");
  }
  return parsed as KnowledgeRecord[];
}

function toIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PersistenceError("Invalid date returned by Postgres.");
  }
  return parsed.toISOString();
}
