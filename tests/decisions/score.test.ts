import { describe, expect, it } from "vitest";
import { ScoreStrategy } from "../../src/decisions/score/score-strategy.ts";
import type { ScoreAnswer, ScoredKnowledge } from "../../src/index.ts";
import { cosineMeasure } from "../../src/strategies/similarity/similarity-measure.ts";
import { createEngine, text, thresholds, vector } from "../helpers/fixtures.ts";

function knowledge(
  id: string,
  polarity: "positive" | "negative",
  values: number[],
  similarity: number,
): ScoredKnowledge {
  return {
    stateId: "salon",
    knowledgeId: id,
    content: id,
    polarity,
    similarity,
    vector: values,
    modelId: "deterministic-test",
    dimensions: 4,
    contentHash: id,
  };
}

describe("score decision", () => {
  const strategy = new ScoreStrategy();
  const scale = { min: 0, max: 100, step: 10 };
  const context = {
    optionVectors: new Map<string, number[]>(),
    thresholds,
    state: {
      id: "salon",
      version: 1,
      categories: [],
      relations: [],
      constraints: [],
    },
    modelId: "deterministic-test",
    similarity: cosineMeasure,
  };

  it("rescales the cosine onto the step and does not call it confidence", () => {
    const answer = strategy.decide({
      question: {
        id: "compat",
        type: "score",
        question: "What is the compatibility level?",
        scale,
      },
      questionVector: vector.cancel,
      knowledge: [knowledge("k1", "positive", vector.cancel, 0.94)],
      ...context,
    });

    expect(answer.decision).toBe("SCORED");
    expect(answer.value).toBe(90);
    expect(answer.basis).toBe("rescaled-cosine");
    expect(answer.support).toBeCloseTo(0.94);
    expect(answer.oppose).toBe(0);
  });

  it("subtracts the opposing evidence when margin resolution is active", () => {
    const answer = strategy.decide({
      question: {
        id: "compat",
        type: "score",
        question: "What is the compatibility level?",
        scale,
      },
      questionVector: vector.cancel,
      knowledge: [
        knowledge("k-yes", "positive", vector.cancel, 1),
        knowledge("k-no", "negative", vector.choiceCancel, 0.8),
      ],
      ...context,
      thresholds: { ...thresholds, conflictResolution: "margin" },
    });

    expect(answer.decision).toBe("SCORED");
    expect(answer.value).toBe(20);
    expect(answer.support).toBeCloseTo(1);
    expect(answer.oppose).toBeCloseTo(0.8);
  });

  it("does not score a contradiction or missing evidence", () => {
    const contradictory = strategy.decide({
      question: {
        id: "compat",
        type: "score",
        question: "What is the compatibility level?",
        scale,
      },
      questionVector: vector.cancel,
      knowledge: [
        knowledge("k-yes", "positive", vector.cancel, 1),
        knowledge("k-no", "negative", vector.nearCancel, 0.99),
      ],
      ...context,
    });
    const absent = strategy.decide({
      question: {
        id: "compat",
        type: "score",
        question: "What is the compatibility level?",
        scale,
      },
      questionVector: vector.cancel,
      knowledge: [],
      ...context,
    });

    expect(contradictory.decision).toBe("UNDETERMINED");
    expect(contradictory.reason).toBe("CONTRADICTORY");
    expect(contradictory.value).toBeUndefined();
    expect(absent.decision).toBe("UNDETERMINED");
    expect(absent.reason).toBe("NO_EVIDENCE");
    expect(absent.value).toBeUndefined();
  });

  it("does not turn an unrelated question into a zero score through the engine", async () => {
    const { engine } = createEngine({
      [text.allowCancel]: vector.cancel,
      [text.unrelated]: vector.unrelated,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });
    const result = await engine.decide({
      stateId: "salon",
      questions: [
        {
          id: "compat",
          type: "score",
          question: text.unrelated,
          scale,
        },
      ],
    });
    const answer = result.answers[0] as ScoreAnswer;

    expect(answer.decision).toBe("UNDETERMINED");
    expect(answer.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(answer.value).toBeUndefined();
  });
});
