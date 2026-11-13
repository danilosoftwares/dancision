import type { PersistenceSession } from "../persistence/transaction.js";
import type { StateRecord } from "../types/state.js";

export interface StateRepository {
  save(state: StateRecord, session?: PersistenceSession): Promise<void>;
  get(id: string, session?: PersistenceSession): Promise<StateRecord | null>;
  delete(id: string, session?: PersistenceSession): Promise<void>;
  insert?(state: StateRecord, session?: PersistenceSession): Promise<void>;
  compareAndSave?(
    state: StateRecord,
    expectedVersion: number,
    session?: PersistenceSession,
  ): Promise<boolean>;
  deleteIfVersion?(
    id: string,
    expectedVersion: number,
    session?: PersistenceSession,
  ): Promise<boolean>;
}
