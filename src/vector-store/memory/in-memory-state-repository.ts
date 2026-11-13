import { DuplicateStateError } from "../../core/errors/index.js";
import type { StateRepository } from "../../core/interfaces/state-repository.js";
import type { PersistenceSession } from "../../core/persistence/transaction.js";
import type { StateRecord } from "../../core/types/state.js";
import { clone } from "../../utils/clone.js";

export class InMemoryStateRepository implements StateRepository {
  private readonly items = new Map<string, StateRecord>();

  async save(state: StateRecord, _session?: PersistenceSession): Promise<void> {
    this.items.set(state.id, clone(state));
  }

  async insert(state: StateRecord, _session?: PersistenceSession): Promise<void> {
    if (this.items.has(state.id)) {
      throw new DuplicateStateError(state.id);
    }
    this.items.set(state.id, clone(state));
  }

  async compareAndSave(
    state: StateRecord,
    expectedVersion: number,
    _session?: PersistenceSession,
  ): Promise<boolean> {
    const current = this.items.get(state.id);
    if (!current || current.version !== expectedVersion) {
      return false;
    }
    this.items.set(state.id, clone(state));
    return true;
  }

  async get(id: string, _session?: PersistenceSession): Promise<StateRecord | null> {
    const state = this.items.get(id);
    return state ? clone(state) : null;
  }

  async delete(id: string, _session?: PersistenceSession): Promise<void> {
    this.items.delete(id);
  }

  async deleteIfVersion(
    id: string,
    expectedVersion: number,
    _session?: PersistenceSession,
  ): Promise<boolean> {
    const current = this.items.get(id);
    if (!current || current.version !== expectedVersion) {
      return false;
    }
    this.items.delete(id);
    return true;
  }
}
