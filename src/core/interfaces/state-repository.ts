import type { StateRecord } from "../types/state.js";

export interface StateRepository {
  save(state: StateRecord): Promise<void>;
  get(id: string): Promise<StateRecord | null>;
  delete(id: string): Promise<void>;
}
