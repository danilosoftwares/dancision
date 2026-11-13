import { randomUUID } from "node:crypto";
import type { PersistenceSession } from "../../core/persistence/transaction.js";
import type { PgQueryable } from "./identifiers.js";

export interface PgClient extends PgQueryable {
  release(): void;
}

export interface PgConnectable extends PgQueryable {
  connect(): Promise<PgClient>;
}

export interface PgPersistenceSession extends PersistenceSession {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export class PgTransactionCoordinator {
  readonly transactionKey: string;

  constructor(
    private readonly db: PgQueryable,
    private readonly ready: () => Promise<void>,
  ) {
    this.transactionKey = `pg:${randomUUID()}`;
  }

  async runInTransaction<T>(work: (session: PersistenceSession) => Promise<T>): Promise<T> {
    await this.ready();
    const connect = connectOf(this.db);
    if (connect) {
      const client = await connect.call(this.db);
      try {
        await client.query("BEGIN");
        const result = await work(this.sessionFor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    try {
      await this.db.query("BEGIN");
      const result = await work(this.sessionFor(this.db));
      await this.db.query("COMMIT");
      return result;
    } catch (error) {
      await this.db.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  queryFor(session?: PersistenceSession): PgQueryable["query"] {
    if (isPgSession(session, this.transactionKey)) {
      return session.query.bind(session);
    }
    return this.db.query.bind(this.db);
  }

  private sessionFor(db: PgQueryable): PgPersistenceSession {
    return {
      transactionKey: this.transactionKey,
      query: db.query.bind(db),
    };
  }
}

function connectOf(db: PgQueryable): PgConnectable["connect"] | null {
  if (!("connect" in db)) {
    return null;
  }
  const connect = (db as PgConnectable).connect;
  return typeof connect === "function" ? connect : null;
}

function isPgSession(
  session: PersistenceSession | undefined,
  transactionKey: string,
): session is PgPersistenceSession {
  if (!session || session.transactionKey !== transactionKey || !("query" in session)) {
    return false;
  }
  return typeof (session as PgPersistenceSession).query === "function";
}
