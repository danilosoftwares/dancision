import type { EmbeddingProvider } from "../core/interfaces/embedding-provider.js";
import type { StateRepository } from "../core/interfaces/state-repository.js";
import type { KnowledgeVector, VectorStore } from "../core/interfaces/vector-store.js";
import {
  DuplicateKnowledgeError,
  DuplicateStateError,
  IncompatibleDimensionsError,
  IncompatibleModelError,
  InvalidDecisionError,
  KnowledgeNotFoundError,
  PersistenceError,
  StateNotFoundError,
  VersionConflictError,
} from "../core/errors/index.js";
import type { PersistenceSession } from "../core/persistence/transaction.js";
import { sharedTransaction } from "../core/persistence/transaction.js";
import type { KnowledgeInput, KnowledgePatch, KnowledgeRecord } from "../core/types/knowledge.js";
import { knowledgeAttributes } from "../core/types/knowledge.js";
import type { StateInput, StatePatch, StateRecord } from "../core/types/state.js";
import { normalizeState } from "../core/types/state.js";
import { EmbeddingService } from "../embeddings/embedding-service.js";
import { clone } from "../utils/clone.js";
import { hashContent } from "../utils/hash.js";
import { validateKnowledgeInput, validateStateGraph } from "../utils/validation.js";
import { KnowledgeManager } from "./knowledge-manager.js";

export class StateManager {
  private readonly knowledge: KnowledgeManager;

  constructor(
    private readonly repository: StateRepository,
    private readonly vectors: VectorStore,
    private readonly embeddings: EmbeddingService,
    private readonly provider: EmbeddingProvider,
  ) {
    this.knowledge = new KnowledgeManager(embeddings, provider);
  }

  async create(input: StateInput): Promise<StateRecord> {
    assertStateIdentity(input.id, input.name);
    const existing = await this.repository.get(input.id);
    if (existing) {
      throw new DuplicateStateError(input.id);
    }

    const indexed = await this.knowledge.embedAll(input.id, input.knowledge ?? []);
    validateStateGraph({
      knowledgeIds: indexed.records.map((item) => item.id),
      ...(input.categories === undefined ? {} : { categories: input.categories }),
      ...(input.relations === undefined ? {} : { relations: input.relations }),
      ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    const timestamp = new Date().toISOString();
    const record: StateRecord = {
      id: input.id,
      name: input.name,
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      categories: input.categories ?? [],
      relations: input.relations ?? [],
      constraints: input.constraints ?? [],
      knowledge: indexed.records,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.transaction(async (session) => {
      await this.insertState(record, session);
      if (indexed.vectors.length > 0) {
        await this.writeEach(indexed.vectors, session);
      }
    });

    return clone(record);
  }

  async update(stateId: string, patch: StatePatch): Promise<StateRecord> {
    const state = await this.require(stateId);
    const name = patch.name ?? state.name;
    if (name.trim().length === 0) {
      throw new InvalidDecisionError("State name is empty.");
    }
    const description =
      patch.description === undefined
        ? state.description
        : patch.description.trim().length === 0
          ? undefined
          : patch.description;
    const domain =
      patch.domain === undefined
        ? state.domain
        : patch.domain.trim().length === 0
          ? undefined
          : patch.domain;
    const metadata = patch.metadata === undefined ? state.metadata : patch.metadata;
    const categories = patch.categories ?? state.categories;
    const relations = patch.relations ?? state.relations;
    const constraints = patch.constraints ?? state.constraints;
    validateStateGraph({
      knowledgeIds: state.knowledge.map((item) => item.id),
      categories,
      relations,
      constraints,
      ...(metadata === undefined ? {} : { metadata }),
    });

    const updated: StateRecord = {
      ...state,
      name,
      categories,
      relations,
      constraints,
      version: state.version + 1,
      ...(description === undefined ? {} : { description }),
      ...(domain === undefined ? {} : { domain }),
      ...(metadata === undefined ? {} : { metadata }),
      updatedAt: new Date().toISOString(),
    };
    if (description === undefined) {
      delete updated.description;
    }
    if (domain === undefined) {
      delete updated.domain;
    }
    if (metadata === undefined) {
      delete updated.metadata;
    }
    await this.commit(state, updated, async () => {}, async () => {});
    return clone(updated);
  }

  async addKnowledge(stateId: string, input: KnowledgeInput): Promise<StateRecord> {
    const state = await this.require(stateId);
    if (state.knowledge.some((item) => item.id === input.id)) {
      throw new DuplicateKnowledgeError(stateId, input.id);
    }
    if (state.knowledge.length > 0) {
      this.assertCurrentModel(state);
    }

    const indexed = await this.knowledge.embedAll(stateId, [input]);
    const record = indexed.records[0];
    const vector = indexed.vectors[0];
    if (!record || !vector) {
      throw new PersistenceError("Could not index the knowledge.");
    }

    const updated = this.withKnowledge(state, [...state.knowledge, record]);
    await this.commit(
      state,
      updated,
      async (session) => {
        await this.vectors.upsert(vector, session);
      },
      async () => {
        await this.vectors.delete(stateId, input.id);
      },
    );
    return clone(updated);
  }

  async updateKnowledge(
    stateId: string,
    knowledgeId: string,
    patch: KnowledgePatch,
  ): Promise<StateRecord> {
    const state = await this.require(stateId);
    const index = state.knowledge.findIndex((item) => item.id === knowledgeId);
    if (index < 0) {
      throw new KnowledgeNotFoundError(stateId, knowledgeId);
    }

    const current = state.knowledge[index];
    if (!current) {
      throw new KnowledgeNotFoundError(stateId, knowledgeId);
    }

    const nextContent = patch.content ?? current.content;
    const nextPolarity = patch.polarity ?? current.polarity;
    const nextMetadata = patch.metadata === undefined ? current.metadata : patch.metadata;
    const nextCategories = patch.categories === undefined ? current.categories : patch.categories;
    const nextWeight = patch.weight === undefined ? current.weight : patch.weight;
    const nextPriority = patch.priority === undefined ? current.priority : patch.priority;
    const nextSource = patch.source === undefined ? current.source : patch.source;
    const merged: KnowledgeInput = {
      id: knowledgeId,
      content: nextContent,
      polarity: nextPolarity,
      ...knowledgeAttributes({
        ...(nextMetadata === undefined ? {} : { metadata: nextMetadata }),
        ...(nextCategories === undefined ? {} : { categories: nextCategories }),
        ...(nextWeight === undefined ? {} : { weight: nextWeight }),
        ...(nextPriority === undefined ? {} : { priority: nextPriority }),
        ...(nextSource === undefined ? {} : { source: nextSource }),
      }),
    };
    const contentChanged = nextContent !== current.content;
    const structureChanged = JSON.stringify(knowledgeAttributes(current)) !== JSON.stringify(knowledgeAttributes(merged)) || nextPolarity !== current.polarity;

    if (!contentChanged && !structureChanged) {
      return clone(state);
    }

    validateKnowledgeInput(merged);

    const stored = await this.vectors.get(stateId, knowledgeId);
    if (!stored) {
      throw new PersistenceError(
        `Missing vector for knowledge ${knowledgeId} in State ${stateId}.`,
      );
    }

    if (contentChanged) {
      this.assertCurrentModel(state);
      const [embedded] = await this.embeddings.embedMany([nextContent]);
      if (!embedded) {
        throw new PersistenceError("Could not generate the updated embedding.");
      }
      const record = this.toRecord(merged);
      const updated = this.replaceAt(state, index, record);
      const nextVector: KnowledgeVector = {
        ...stored,
        content: nextContent,
        polarity: nextPolarity,
        vector: embedded,
        modelId: this.provider.modelId,
        dimensions: this.provider.dimensions,
        contentHash: record.contentHash,
        ...knowledgeAttributes(merged),
      };
      deleteEmptyAttributes(nextVector);
      await this.commit(
        state,
        updated,
        async (session) => {
          await this.vectors.upsert(nextVector, session);
        },
        async () => {
          await this.vectors.upsert(stored);
        },
      );
      return clone(updated);
    }

    const record: KnowledgeRecord = {
      ...current,
      polarity: nextPolarity,
      contentHash: current.contentHash,
      ...knowledgeAttributes(merged),
    };
    deleteEmptyAttributes(record);
    const updated = this.replaceAt(state, index, record);
    const nextVector: KnowledgeVector = {
      ...stored,
      polarity: nextPolarity,
      ...knowledgeAttributes(merged),
    };
    deleteEmptyAttributes(nextVector);
    await this.commit(
      state,
      updated,
      async (session) => {
        await this.vectors.upsert(nextVector, session);
      },
      async () => {
        await this.vectors.upsert(stored);
      },
    );
    return clone(updated);
  }

  async removeKnowledge(stateId: string, knowledgeId: string): Promise<StateRecord> {
    const state = await this.require(stateId);
    if (!state.knowledge.some((item) => item.id === knowledgeId)) {
      throw new KnowledgeNotFoundError(stateId, knowledgeId);
    }
    const stored = await this.vectors.get(stateId, knowledgeId);
    const knowledge = state.knowledge.filter((item) => item.id !== knowledgeId);
    const updated = this.withKnowledge(
      {
        ...state,
        relations: state.relations.filter(
          (relation) => relation.from !== knowledgeId && relation.to !== knowledgeId,
        ),
      },
      knowledge,
    );
    await this.commit(
      state,
      updated,
      async (session) => {
        await this.vectors.delete(stateId, knowledgeId, session);
      },
      async () => {
        if (stored) {
          await this.vectors.upsert(stored);
        }
      },
    );
    return clone(updated);
  }

  async reprocess(stateId: string): Promise<StateRecord> {
    const state = await this.require(stateId);
    const previousVectors: KnowledgeVector[] = [];
    for (const item of state.knowledge) {
      const stored = await this.vectors.get(stateId, item.id);
      if (stored) {
        previousVectors.push(stored);
      }
    }

    const indexed = await this.knowledge.embedAll(
      stateId,
      state.knowledge.map((item) => ({
        id: item.id,
        content: item.content,
        polarity: item.polarity,
        ...knowledgeAttributes(item),
      })),
    );
    const updated = this.withKnowledge(state, indexed.records);
    await this.commit(
      state,
      updated,
      async (session) => {
        if (indexed.vectors.length > 0) {
          await this.writeEach(indexed.vectors, session);
        }
      },
      async () => {
        if (previousVectors.length > 0) {
          await this.vectors.upsertMany(previousVectors);
        }
      },
    );
    return clone(updated);
  }

  async get(stateId: string): Promise<StateRecord> {
    return clone(await this.require(stateId));
  }

  async delete(stateId: string): Promise<void> {
    const state = await this.repository.get(stateId);
    if (!state) {
      await this.vectors.deleteByState(stateId);
      return;
    }

    const snapshots: KnowledgeVector[] = [];
    for (const item of state.knowledge) {
      const stored = await this.vectors.get(stateId, item.id);
      if (stored) {
        snapshots.push(stored);
      }
    }

    const transactional = sharedTransaction(this.repository, this.vectors);
    if (transactional) {
      await transactional.runInTransaction(async (session) => {
        const removed = await this.deleteVersion(stateId, state.version, session);
        if (!removed) {
          const current = await this.repository.get(stateId, session);
          throw new VersionConflictError(stateId, state.version, current?.version ?? null);
        }
        await this.vectors.deleteByState(stateId, session);
      });
      return;
    }

    const removed = await this.deleteVersion(stateId, state.version);
    if (!removed) {
      const current = await this.repository.get(stateId);
      throw new VersionConflictError(stateId, state.version, current?.version ?? null);
    }
    try {
      await this.vectors.deleteByState(stateId);
    } catch (error) {
      await this.restoreDeletedState(state, snapshots, error);
      throw error;
    }
  }

  private async require(stateId: string): Promise<StateRecord> {
    const state = await this.repository.get(stateId);
    if (!state) {
      throw new StateNotFoundError(stateId);
    }
    return normalizeState(state);
  }

  private assertCurrentModel(state: StateRecord): void {
    for (const item of state.knowledge) {
      if (item.modelId !== this.provider.modelId) {
        throw new IncompatibleModelError(this.provider.modelId, item.modelId);
      }
      if (item.dimensions !== this.provider.dimensions) {
        throw new IncompatibleDimensionsError(this.provider.dimensions, item.dimensions);
      }
    }
  }

  private toRecord(input: KnowledgeInput): KnowledgeRecord {
    return {
      id: input.id,
      content: input.content,
      polarity: input.polarity,
      contentHash: hashContent(input.content),
      modelId: this.provider.modelId,
      dimensions: this.provider.dimensions,
      ...knowledgeAttributes(input),
    };
  }

  private replaceAt(
    state: StateRecord,
    index: number,
    record: KnowledgeRecord,
  ): StateRecord {
    const knowledge = state.knowledge.slice();
    knowledge[index] = record;
    return this.withKnowledge(state, knowledge);
  }

  private withKnowledge(state: StateRecord, knowledge: KnowledgeRecord[]): StateRecord {
    return {
      ...state,
      knowledge,
      version: state.version + 1,
      updatedAt: new Date().toISOString(),
    };
  }

  private async transaction<T>(
    work: (session?: PersistenceSession) => Promise<T>,
  ): Promise<T> {
    const transactional = sharedTransaction(this.repository, this.vectors);
    if (!transactional) {
      return work(undefined);
    }
    return transactional.runInTransaction(work);
  }

  private async insertState(record: StateRecord, session?: PersistenceSession): Promise<void> {
    if (this.repository.insert) {
      await this.repository.insert(record, session);
      return;
    }
    const existing = await this.repository.get(record.id, session);
    if (existing) {
      throw new DuplicateStateError(record.id);
    }
    await this.repository.save(record, session);
  }

  private async writeEach(
    vectors: KnowledgeVector[],
    session?: PersistenceSession,
  ): Promise<void> {
    if (session) {
      await this.vectors.upsertMany(vectors, session);
      return;
    }
    const stateId = vectors[0]?.stateId ?? "";
    const written: string[] = [];
    try {
      for (const vector of vectors) {
        written.push(vector.knowledgeId);
        await this.vectors.upsert(vector);
      }
    } catch (error) {
      await this.compensateCreate(stateId, written, error);
      throw error;
    }
  }

  private async compensateCreate(
    stateId: string,
    writtenKnowledgeIds: string[],
    cause: unknown,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const knowledgeId of writtenKnowledgeIds) {
      try {
        await this.vectors.delete(stateId, knowledgeId);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.repository.delete(stateId);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new PersistenceError(
        `Persistence failed and compensation could not remove the partial State ${stateId}. ${describeError(cause)} Compensation: ${failures.map(describeError).join(" ")}`,
      );
    }
  }

  private async commit(
    previous: StateRecord,
    next: StateRecord,
    writeVectors: (session?: PersistenceSession) => Promise<void>,
    rollbackVectors: () => Promise<void>,
  ): Promise<void> {
    const transactional = sharedTransaction(this.repository, this.vectors);
    if (transactional) {
      await transactional.runInTransaction(async (session) => {
        await this.writeVersion(next, previous.version, session);
        await writeVectors(session);
      });
      return;
    }

    await this.writeVersion(next, previous.version);
    try {
      await writeVectors();
    } catch (error) {
      await this.compensateUpdate(previous, next.version, rollbackVectors, error);
      throw error;
    }
  }

  private async writeVersion(
    next: StateRecord,
    expectedVersion: number,
    session?: PersistenceSession,
  ): Promise<void> {
    if (this.repository.compareAndSave) {
      const saved = await this.repository.compareAndSave(next, expectedVersion, session);
      if (!saved) {
        const current = await this.repository.get(next.id, session);
        throw new VersionConflictError(next.id, expectedVersion, current?.version ?? null);
      }
      return;
    }
    const current = await this.repository.get(next.id, session);
    if (!current || current.version !== expectedVersion) {
      throw new VersionConflictError(next.id, expectedVersion, current?.version ?? null);
    }
    await this.repository.save(next, session);
  }

  private async compensateUpdate(
    previous: StateRecord,
    writtenVersion: number,
    rollbackVectors: () => Promise<void>,
    cause: unknown,
  ): Promise<void> {
    let restored = false;
    try {
      if (this.repository.compareAndSave) {
        restored = await this.repository.compareAndSave(previous, writtenVersion);
      } else {
        await this.repository.save(previous);
        restored = true;
      }
    } catch (error) {
      throw new PersistenceError(
        `Vector write failed and the State ${previous.id} could not be restored. ${describeError(cause)} Restore: ${describeError(error)}`,
      );
    }
    try {
      await rollbackVectors();
    } catch (error) {
      throw new PersistenceError(
        `Vector write failed and the vector rollback also failed. ${describeError(cause)} Rollback: ${describeError(error)}`,
      );
    }
    if (!restored) {
      throw new PersistenceError(
        `Vector write failed and State ${previous.id} changed again before it could be restored. ${describeError(cause)}`,
      );
    }
  }

  private async deleteVersion(
    stateId: string,
    expectedVersion: number,
    session?: PersistenceSession,
  ): Promise<boolean> {
    if (this.repository.deleteIfVersion) {
      return this.repository.deleteIfVersion(stateId, expectedVersion, session);
    }
    const current = await this.repository.get(stateId, session);
    if (!current || current.version !== expectedVersion) {
      return false;
    }
    await this.repository.delete(stateId, session);
    return true;
  }

  private async restoreDeletedState(
    state: StateRecord,
    snapshots: KnowledgeVector[],
    cause: unknown,
  ): Promise<void> {
    try {
      await this.repository.save(state);
      if (snapshots.length > 0) {
        await this.vectors.upsertMany(snapshots);
      }
    } catch (error) {
      throw new PersistenceError(
        `State ${state.id} was removed and could not be restored after a vector delete failure. ${describeError(cause)} Restore: ${describeError(error)}`,
      );
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertStateIdentity(id: string, name: string): void {
  if (!id || id.trim().length === 0) {
    throw new InvalidDecisionError("State is missing an id.");
  }
  if (!name || name.trim().length === 0) {
    throw new InvalidDecisionError("State is missing a name.");
  }
}

function deleteEmptyAttributes(target: {
  metadata?: Record<string, unknown>;
  categories?: string[];
  weight?: number;
  priority?: number;
  source?: string;
}): void {
  if (target.metadata === undefined) {
    delete target.metadata;
  }
  if (target.categories === undefined) {
    delete target.categories;
  }
  if (target.weight === undefined) {
    delete target.weight;
  }
  if (target.priority === undefined) {
    delete target.priority;
  }
  if (target.source === undefined) {
    delete target.source;
  }
}
