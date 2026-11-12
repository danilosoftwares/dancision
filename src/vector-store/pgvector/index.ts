import { PersistenceError } from "../../core/errors/index.js";
import {
  resolvePgSchemaConfig,
  type PgQueryable,
  type PgSchemaConfig,
} from "./identifiers.js";
import { PgStateRepository } from "./pg-state-repository.js";
import { PgVectorStore } from "./pg-vector-store.js";
import { ensurePgSchema } from "./schema.js";

export { PgStateRepository } from "./pg-state-repository.js";
export { PgVectorStore } from "./pg-vector-store.js";
export { ensurePgSchema } from "./schema.js";
export type { PgQueryable, PgSchemaConfig } from "./identifiers.js";

export interface PgPersistenceOptions {
  db?: PgQueryable;
  connectionString?: string;
  schema?: string;
  tablePrefix?: string;
  dimensions: number;
}

export interface PgPersistence {
  db: PgQueryable;
  states: PgStateRepository;
  vectors: PgVectorStore;
}

interface PgPoolLike extends PgQueryable {
  end(): Promise<void>;
}

interface PgModule {
  Pool?: new (config: { connectionString: string }) => PgPoolLike;
  default?: PgModule;
}

export function createPgStores(
  db: PgQueryable,
  options: {
    schema?: string;
    tablePrefix?: string;
    dimensions: number;
  },
): { states: PgStateRepository; vectors: PgVectorStore } {
  const config = resolvePgSchemaConfig(options);
  const ready = createSchemaReady(db, config);
  return {
    states: new PgStateRepository(db, config, ready),
    vectors: new PgVectorStore(db, config, ready),
  };
}

export async function createPgPersistence(
  options: PgPersistenceOptions,
): Promise<PgPersistence> {
  const db = options.db ?? (await createPgPool(options.connectionString ?? ""));
  const stores = createPgStores(db, options);
  return {
    db,
    states: stores.states,
    vectors: stores.vectors,
  };
}

export async function createPgPool(connectionString: string): Promise<PgPoolLike> {
  if (!connectionString || connectionString.trim().length === 0) {
    throw new PersistenceError("connectionString is empty.");
  }

  let imported: PgModule;
  try {
    const moduleName = "pg";
    imported = (await import(moduleName)) as PgModule;
  } catch {
    throw new PersistenceError(
      "Package pg is not installed. Install pg to use PostgreSQL storage.",
    );
  }

  const Pool = imported.Pool ?? imported.default?.Pool;
  if (!Pool) {
    throw new PersistenceError("Could not load Pool from the pg package.");
  }
  return new Pool({ connectionString });
}

function createSchemaReady(
  db: PgQueryable,
  config: PgSchemaConfig,
): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (!pending) {
      pending = ensurePgSchema(db, config).catch((error: unknown) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}
