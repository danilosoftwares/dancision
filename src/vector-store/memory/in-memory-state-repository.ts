import type { StateRepository } from "../../core/interfaces/state-repository.js";
import type { StateRecord } from "../../core/types/state.js";
import { clone } from "../../utils/clone.js";

export class InMemoryStateRepository implements StateRepository {
  private readonly items = new Map<string, StateRecord>();

  async save(state: StateRecord): Promise<void> {
    this.items.set(state.id, clone(state));
  }

  async get(id: string): Promise<StateRecord | null> {
    const state = this.items.get(id);
    return state ? clone(state) : null;
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}
