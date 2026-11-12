import { describe, expect, it } from "vitest";
import type { NoulAnswer } from "../../src/index.ts";
import { createEngine, text, vector } from "../helpers/fixtures.ts";

async function noul(
  vectors: Record<string, number[]>,
  knowledge: { id: string; content: string; polarity: "positive" | "negative" }[],
  question: string,
  polarity?: "affirmative" | "negative",
): Promise<NoulAnswer> {
  const { engine } = createEngine(vectors);
  await engine.states.create({
    id: "salon",
    name: "Salon",
    knowledge,
  });
  const result = await engine.decide({
    stateId: "salon",
    questions: [
      {
        id: "q1",
        type: "noul",
        question,
        ...(polarity === undefined ? {} : { polarity }),
      },
    ],
  });
  return result.answers[0] as NoulAnswer;
}

describe("noul decision", () => {
  it("accepts a question that is semantically equivalent to the knowledge", async () => {
    const answer = await noul(
      {
        [text.allowCancel]: vector.cancel,
        [text.askCancel]: vector.cancel,
      },
      [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      text.askCancel,
    );

    expect(answer.decision).toBe("YES");
    expect(answer.value).toBe(true);
    expect(answer.evidence.map((item) => item.knowledgeId)).toEqual(["k1"]);
    expect(answer.similarity.positive).toBeCloseTo(1);
    expect(answer.reason).toBeUndefined();
  });

  it("accepts different words when the vector space collapses the meaning", async () => {
    const answer = await noul(
      {
        [text.allowCancel]: vector.cancel,
        [text.askCancelOtherWords]: vector.cancel,
      },
      [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      text.askCancelOtherWords,
    );

    expect(answer.decision).toBe("YES");
    expect(answer.evidence[0]?.knowledgeId).toBe("k1");
  });

  it("answers NO when negative evidence is the only item above the threshold", async () => {
    const answer = await noul(
      {
        [text.denyRecurring]: vector.update,
        [text.askRecurring]: vector.update,
      },
      [{ id: "k3", content: text.denyRecurring, polarity: "negative" }],
      text.askRecurring,
    );

    expect(answer.decision).toBe("NO");
    expect(answer.value).toBe(false);
    expect(answer.similarity.negative).toBeCloseTo(1);
    expect(answer.evidence[0]?.polarity).toBe("negative");
  });

  it("does not turn a written negation in the question into a negative vote", async () => {
    const answer = await noul(
      {
        [text.allowCancel]: vector.cancel,
        [text.askCancelNegated]: vector.cancel,
      },
      [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      text.askCancelNegated,
    );

    expect(answer.decision).toBe("YES");
    expect(answer.value).toBe(true);
  });

  it("inverts the vote only when the question sets negative polarity", async () => {
    const answer = await noul(
      {
        [text.allowCancel]: vector.cancel,
        [text.askCancelNegated]: vector.cancel,
      },
      [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      text.askCancelNegated,
      "negative",
    );

    expect(answer.decision).toBe("NO");
    expect(answer.value).toBe(false);
  });

  it("returns a contradiction when both sides stay above the threshold without a separating margin", async () => {
    const answer = await noul(
      {
        [text.allowCancel]: vector.cancel,
        [text.denyCancel]: vector.nearCancel,
        [text.askCancel]: vector.cancel,
      },
      [
        { id: "k-yes", content: text.allowCancel, polarity: "positive" },
        { id: "k-no", content: text.denyCancel, polarity: "negative" },
      ],
      text.askCancel,
    );

    expect(answer.decision).toBe("UNDETERMINED");
    expect(answer.reason).toBe("CONTRADICTORY");
    expect(answer.value).toBeUndefined();
    expect(answer.evidence.map((item) => item.knowledgeId).sort()).toEqual([
      "k-no",
      "k-yes",
    ]);
  });

  it("does not choose the higher cosine when both sides remain relevant", async () => {
    const opposed = [0.8, 0.6, 0, 0];
    const answer = await noul(
      {
        [text.allowCancel]: vector.cancel,
        [text.denyCancel]: opposed,
        [text.askCancel]: vector.cancel,
      },
      [
        { id: "k-yes", content: text.allowCancel, polarity: "positive" },
        { id: "k-no", content: text.denyCancel, polarity: "negative" },
      ],
      text.askCancel,
    );

    expect(answer.similarity.negative).toBeCloseTo(0.8);
    expect(answer.decision).toBe("UNDETERMINED");
    expect(answer.reason).toBe("CONTRADICTORY");
    expect(answer.value).toBeUndefined();
  });

  it("does not treat an unrelated question as NO", async () => {
    const answer = await noul(
      {
        [text.allowCancel]: vector.cancel,
        [text.unrelated]: vector.unrelated,
      },
      [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      text.unrelated,
    );

    expect(answer.decision).toBe("UNDETERMINED");
    expect(answer.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(answer.value).toBeUndefined();
    expect(answer.evidence).toEqual([]);
  });

  it("does not treat missing knowledge as NO", async () => {
    const { engine } = createEngine({
      [text.askCancel]: vector.cancel,
    });
    await engine.states.create({ id: "empty", name: "Empty" });
    const result = await engine.decide({
      stateId: "empty",
      questions: [{ id: "q1", type: "noul", question: text.askCancel }],
    });
    const answer = result.answers[0] as NoulAnswer;

    expect(answer.decision).toBe("UNDETERMINED");
    expect(answer.reason).toBe("NO_EVIDENCE");
    expect(answer.value).toBeUndefined();
  });

  it("does not promote similarity below the threshold to YES", async () => {
    const answer = await noul(
      {
        [text.allowCancel]: vector.cancel,
        [text.weakCancel]: vector.weakCancel,
      },
      [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
      text.weakCancel,
    );

    expect(answer.similarity.positive).toBeCloseTo(0.6);
    expect(answer.decision).toBe("UNDETERMINED");
    expect(answer.reason).toBe("INSUFFICIENT_EVIDENCE");
  });
});
