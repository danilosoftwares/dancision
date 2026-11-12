import { describe, expect, it } from "vitest";
import {
  DecisionEngine,
  InMemoryEmbeddingCache,
  InMemoryStateRepository,
  InMemoryVectorStore,
  IncompatibleDimensionsError,
  IncompatibleModelError,
  InvalidDecisionError,
} from "../../src/index.ts";
import {
  SpyProvider,
  createEngine,
  createProvider,
  text,
  thresholds,
  vector,
} from "../helpers/fixtures.ts";

describe("DecisionEngine", () => {
  it("does not leak knowledge between States", async () => {
    const { engine } = createEngine({
      [text.allowCancel]: vector.cancel,
      [text.unrelated]: vector.unrelated,
      [text.askCancel]: vector.cancel,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k-salon", content: text.allowCancel, polarity: "positive" }],
    });
    await engine.states.create({
      id: "clinic",
      name: "Clinic",
      knowledge: [{ id: "k-clinic", content: text.unrelated, polarity: "positive" }],
    });

    const salon = await engine.decide({
      stateId: "salon",
      questions: [{ id: "q", type: "noul", question: text.askCancel }],
    });
    const clinic = await engine.decide({
      stateId: "clinic",
      questions: [{ id: "q", type: "noul", question: text.askCancel }],
    });

    expect(salon.answers[0]?.decision).toBe("YES");
    expect(clinic.answers[0]?.decision).toBe("UNDETERMINED");
    expect(clinic.answers[0]?.reason).toBe("INSUFFICIENT_EVIDENCE");
    if (clinic.answers[0] && "evidence" in clinic.answers[0]) {
      expect(clinic.answers[0].evidence).toEqual([]);
    }
  });

  it("rejects an incompatible dimension and model without reprocessing during the query", async () => {
    const states = new InMemoryStateRepository();
    const vectors = new InMemoryVectorStore();
    const original = createProvider({
      [text.allowCancel]: vector.cancel,
    });
    const engine = new DecisionEngine({
      embeddings: original,
      vectors,
      states,
      thresholds,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });

    const otherModel = new DecisionEngine({
      embeddings: createProvider(
        { [text.askCancel]: vector.cancel },
        "other-model",
      ),
      vectors,
      states,
      thresholds,
    });
    await expect(
      otherModel.decide({
        stateId: "salon",
        questions: [{ id: "q", type: "noul", question: text.askCancel }],
      }),
    ).rejects.toBeInstanceOf(IncompatibleModelError);

    const otherDimension = new DecisionEngine({
      embeddings: createProvider(
        { [text.askCancel]: [1, 0, 0, 0, 0, 0, 0, 0] },
        "deterministic-test",
        8,
      ),
      vectors,
      states,
      thresholds,
    });
    await expect(
      otherDimension.decide({
        stateId: "salon",
        questions: [{ id: "q", type: "noul", question: text.askCancel }],
      }),
    ).rejects.toBeInstanceOf(IncompatibleDimensionsError);
  });

  it("does not generate State embeddings again during the query", async () => {
    const inner = createProvider({
      [text.allowCancel]: vector.cancel,
      [text.askCancel]: vector.cancel,
      [text.allowCreate]: vector.create,
    });
    const spy = new SpyProvider(inner);
    const engine = new DecisionEngine({
      embeddings: spy,
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      thresholds,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });

    spy.calls.length = 0;
    await engine.decide({
      stateId: "salon",
      questions: [{ id: "q", type: "noul", question: text.askCancel }],
    });
    expect(spy.calls).toEqual([text.askCancel]);

    spy.calls.length = 0;
    await engine.states.updateKnowledge("salon", "k1", { polarity: "negative" });
    expect(spy.calls).toEqual([]);

    const reversed = await engine.decide({
      stateId: "salon",
      questions: [{ id: "q", type: "noul", question: text.askCancel }],
    });
    expect(reversed.answers[0]?.decision).toBe("NO");

    inner.register(text.allowCreate, vector.create);
    spy.calls.length = 0;
    await engine.states.updateKnowledge("salon", "k1", { content: text.allowCreate });
    expect(spy.calls).toEqual([text.allowCreate]);

    spy.calls.length = 0;
    await engine.states.reprocess("salon");
    expect(spy.calls).toEqual([text.allowCreate]);
  });

  it("reuses question embeddings through the cache", async () => {
    const inner = createProvider({
      [text.allowCancel]: vector.cancel,
      [text.askCancel]: vector.cancel,
    });
    const spy = new SpyProvider(inner);
    const engine = new DecisionEngine({
      embeddings: spy,
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      cache: new InMemoryEmbeddingCache(),
      thresholds,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });
    const request = {
      stateId: "salon",
      questions: [{ id: "q", type: "noul" as const, question: text.askCancel }],
    };

    spy.calls.length = 0;
    await engine.decide(request);
    const afterFirst = spy.calls.length;
    await engine.decide(request);

    expect(afterFirst).toBe(1);
    expect(spy.calls).toHaveLength(afterFirst);
  });

  it("accepts a new strategy without changing the core", async () => {
    const { engine } = createEngine({
      [text.askCancel]: vector.cancel,
    });
    engine.registerStrategy({
      type: "presence",
      version: "1.0.0",
      decide(context) {
        return {
          questionId: context.question.id,
          type: "presence",
          decision: context.knowledge.length > 0 ? "PRESENT" : "EMPTY",
          evidence: [],
        };
      },
    });
    await engine.states.create({ id: "salon", name: "Salon" });

    const result = await engine.decide({
      stateId: "salon",
      questions: [{ id: "q", type: "presence", question: text.askCancel }],
    });

    expect(result.answers[0]).toMatchObject({
      questionId: "q",
      type: "presence",
      decision: "EMPTY",
      evidence: [],
    });
    expect(result.answers[0]?.explanation.strategy).toEqual({
      type: "presence",
      version: "1.0.0",
    });
    expect(result.answers[0]?.explanation.result).toBe("EMPTY");
    expect(() =>
      engine.registerStrategy({
        type: "presence",
        version: "1.0.1",
        decide: () => ({ questionId: "x", type: "presence", decision: "EMPTY", evidence: [] }),
      }),
    ).toThrow(InvalidDecisionError);
  });
});
