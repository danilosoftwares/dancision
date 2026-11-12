import { describe, expect, it } from "vitest";
import type { ChoiceAnswer, ChoiceQuestion } from "../../src/index.ts";
import { createEngine, text, vector } from "../helpers/fixtures.ts";

function choiceQuestion(options: { id: string; description: string }[]): ChoiceQuestion {
  return {
    id: "action",
    type: "choice",
    question: text.choiceQuestion,
    options,
  };
}

describe("choice decision", () => {
  it("selects the alternative whose meaning is apart from the others", async () => {
    const { engine } = createEngine({
      [text.choiceQuestion]: vector.cancel,
      [text.optionCreate]: vector.create,
      [text.optionCancel]: vector.cancel,
      [text.optionUpdate]: vector.update,
      [text.allowCancel]: vector.cancel,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });

    const result = await engine.decide({
      stateId: "salon",
      questions: [
        choiceQuestion([
          { id: "create", description: text.optionCreate },
          { id: "cancel", description: text.optionCancel },
          { id: "update", description: text.optionUpdate },
        ]),
      ],
    });
    const answer = result.answers[0] as ChoiceAnswer;

    expect(answer.decision).toBe("SELECTED");
    expect(answer.selected).toBe("cancel");
    expect(answer.alternatives.map((item) => item.id)).toEqual([
      "create",
      "cancel",
      "update",
    ]);
    const selected = answer.alternatives.find((item) => item.id === "cancel");
    expect(selected?.similarity).toBeCloseTo(1);
    expect(selected?.rankingScore).not.toBe(selected?.similarity);
  });

  it("stays undetermined when the alternatives are almost equal", async () => {
    const { engine } = createEngine(
      {
        [text.choiceQuestion]: vector.cancel,
        [text.optionCancel]: vector.cancel,
        [text.optionReschedule]: vector.nearCancel,
      },
      { thresholds: { choiceEvidenceWeight: 0 } },
    );
    await engine.states.create({ id: "salon", name: "Salon" });

    const result = await engine.decide({
      stateId: "salon",
      questions: [
        choiceQuestion([
          { id: "cancel", description: text.optionCancel },
          { id: "reschedule", description: text.optionReschedule },
        ]),
      ],
    });
    const answer = result.answers[0] as ChoiceAnswer;

    expect(answer.decision).toBe("UNDETERMINED");
    expect(answer.reason).toBe("AMBIGUOUS");
    expect(answer.selected).toBeUndefined();
  });

  it("stays undetermined when no alternative is close to the question", async () => {
    const { engine } = createEngine({
      [text.choiceQuestion]: vector.unrelated,
      [text.optionCreate]: vector.create,
      [text.optionCancel]: vector.cancel,
    });
    await engine.states.create({ id: "salon", name: "Salon" });

    const result = await engine.decide({
      stateId: "salon",
      questions: [
        choiceQuestion([
          { id: "create", description: text.optionCreate },
          { id: "cancel", description: text.optionCancel },
        ]),
      ],
    });
    const answer = result.answers[0] as ChoiceAnswer;

    expect(answer.decision).toBe("UNDETERMINED");
    expect(answer.reason).toBe("WEAK_MATCH");
  });

  it("lets State knowledge change the winning alternative", async () => {
    const vectors = {
      [text.choiceQuestion]: vector.cancel,
      [text.optionCreate]: vector.choiceCreate,
      [text.optionCancel]: vector.choiceCancel,
      [text.supportedCancel]: vector.choiceKnowledge,
    };
    const withoutKnowledge = createEngine(vectors, {
      thresholds: { choiceMargin: 0.05, choiceEvidenceWeight: 0.6 },
    });
    await withoutKnowledge.engine.states.create({ id: "salon", name: "Salon" });
    const ambiguous = (
      await withoutKnowledge.engine.decide({
        stateId: "salon",
        questions: [
          choiceQuestion([
            { id: "create", description: text.optionCreate },
            { id: "cancel", description: text.optionCancel },
          ]),
        ],
      })
    ).answers[0] as ChoiceAnswer;

    const withKnowledge = createEngine(vectors, {
      thresholds: { choiceMargin: 0.05, choiceEvidenceWeight: 0.6 },
    });
    await withKnowledge.engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [
        { id: "k-cancel", content: text.supportedCancel, polarity: "positive" },
      ],
    });
    const selected = (
      await withKnowledge.engine.decide({
        stateId: "salon",
        questions: [
          choiceQuestion([
            { id: "create", description: text.optionCreate },
            { id: "cancel", description: text.optionCancel },
          ]),
        ],
      })
    ).answers[0] as ChoiceAnswer;

    expect(ambiguous.decision).toBe("UNDETERMINED");
    expect(ambiguous.reason).toBe("AMBIGUOUS");
    expect(selected.decision).toBe("SELECTED");
    expect(selected.selected).toBe("cancel");
    expect(selected.evidence.map((item) => item.knowledgeId)).toEqual(["k-cancel"]);
  });
});
