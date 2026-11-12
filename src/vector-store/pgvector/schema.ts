import { PersistenceError, SchemaMismatchError } from "../../core/errors/index.js";
import {
  pgTableNames,
  qualify,
  type PgQueryable,
  type PgSchemaConfig,
} from "./identifiers.js";

interface RelationRow {
  relname: string;
}

interface DimensionRow {
  typmod: number | string;
}

interface ColumnRow {
  column_name: string;
}

const STATE_COLUMN_ADDITIONS = [
  ["version", "integer NOT NULL DEFAULT 1"],
  ["domain", "text"],
  ["metadata", "jsonb"],
  ["categories", "jsonb NOT NULL DEFAULT '[]'::jsonb"],
  ["relations", "jsonb NOT NULL DEFAULT '[]'::jsonb"],
  ["constraints", "jsonb NOT NULL DEFAULT '[]'::jsonb"],
] as const;

export async function ensurePgSchema(
  db: PgQueryable,
  config: PgSchemaConfig,
): Promise<void> {
  try {
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch (error) {
    throw new PersistenceError(
      `Could not ensure the vector extension. Create it with a privileged role if the application role cannot. Detail: ${errorMessage(error)}`,
    );
  }

  const names = pgTableNames(config);
  const states = qualify(config.schema, names.states);
  const knowledge = qualify(config.schema, names.knowledge);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ${states} (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      domain text,
      metadata jsonb,
      categories jsonb NOT NULL DEFAULT '[]'::jsonb,
      relations jsonb NOT NULL DEFAULT '[]'::jsonb,
      constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
      knowledge jsonb NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `);

  const tableExists = await relationExists(db, config.schema, names.knowledge);
  if (!tableExists) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${knowledge} (
        state_id text NOT NULL REFERENCES ${states} (id) ON DELETE CASCADE,
        knowledge_id text NOT NULL,
        content text NOT NULL,
        polarity text NOT NULL CHECK (polarity IN ('positive', 'negative', 'neutral')),
        embedding vector(${config.dimensions}) NOT NULL,
        model_id text NOT NULL,
        dimensions integer NOT NULL,
        content_hash text NOT NULL,
        metadata jsonb,
        PRIMARY KEY (state_id, knowledge_id)
      )
    `);

    const created = await readVectorDimension(db, config.schema, names.knowledge);
    if (created !== null && created !== config.dimensions) {
      throw new SchemaMismatchError(knowledge, config.dimensions, created);
    }
  } else {
    const existing = await readVectorDimension(db, config.schema, names.knowledge);
    if (existing === null) {
      throw new SchemaMismatchError(knowledge, config.dimensions, -1);
    }
    if (existing !== config.dimensions) {
      throw new SchemaMismatchError(knowledge, config.dimensions, existing);
    }
  }

  await ensureStateColumns(db, config.schema, names.states, states);

  await db.query(`
    CREATE INDEX IF NOT EXISTS ${qualify(config.schema, names.index)}
    ON ${knowledge}
    USING hnsw (embedding vector_cosine_ops)
  `);
}

async function ensureStateColumns(
  db: PgQueryable,
  schema: string,
  table: string,
  qualifiedTable: string,
): Promise<void> {
  const result = await db.query<ColumnRow>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
    `,
    [schema, table],
  );
  const present = new Set(result.rows.map((row) => row.column_name));
  for (const [name, definition] of STATE_COLUMN_ADDITIONS) {
    if (present.has(name)) {
      continue;
    }
    await db.query(`ALTER TABLE ${qualifiedTable} ADD COLUMN ${name} ${definition}`);
  }
}

async function relationExists(
  db: PgQueryable,
  schema: string,
  table: string,
): Promise<boolean> {
  const result = await db.query<RelationRow>(
    `
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND c.relkind = 'r'
    `,
    [schema, table],
  );
  return result.rows.length > 0;
}

async function readVectorDimension(
  db: PgQueryable,
  schema: string,
  table: string,
): Promise<number | null> {
  const result = await db.query<DimensionRow>(
    `
      SELECT a.atttypmod AS typmod
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped
    `,
    [schema, table],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const typmod = Number(row.typmod);
  if (!Number.isInteger(typmod) || typmod <= 0) {
    throw new PersistenceError(
      `The embedding column of ${qualify(schema, table)} has no fixed dimension. Use another tablePrefix with vector(N) created by this package.`,
    );
  }
  return typmod;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
