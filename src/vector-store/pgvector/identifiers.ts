import { PersistenceError } from "../../core/errors/index.js";

export interface PgQueryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface PgSchemaConfig {
  schema: string;
  tablePrefix: string;
  dimensions: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function resolvePgSchemaConfig(options: {
  schema?: string;
  tablePrefix?: string;
  dimensions: number;
}): PgSchemaConfig {
  const config: PgSchemaConfig = {
    schema: options.schema ?? "public",
    tablePrefix: options.tablePrefix ?? "sde",
    dimensions: options.dimensions,
  };
  assertSqlIdentifier(config.schema, "schema");
  assertSqlIdentifier(config.tablePrefix, "tablePrefix");
  if (!Number.isInteger(config.dimensions) || config.dimensions < 1 || config.dimensions > 16000) {
    throw new PersistenceError(
      "pgvector dimensions must be an integer between 1 and 16000.",
    );
  }
  const indexName = `${config.tablePrefix}_knowledge_embedding_hnsw`;
  if (indexName.length > 63) {
    throw new PersistenceError(
      "tablePrefix produces an index name longer than 63 characters.",
    );
  }
  return config;
}

export function assertSqlIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new PersistenceError(`Invalid ${label}: ${value}`);
  }
}

export function quoteIdent(value: string): string {
  assertSqlIdentifier(value, "identifier");
  return `"${value}"`;
}

export function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function pgTableNames(config: PgSchemaConfig): {
  states: string;
  knowledge: string;
  index: string;
} {
  return {
    states: `${config.tablePrefix}_states`,
    knowledge: `${config.tablePrefix}_knowledge`,
    index: `${config.tablePrefix}_knowledge_embedding_hnsw`,
  };
}
