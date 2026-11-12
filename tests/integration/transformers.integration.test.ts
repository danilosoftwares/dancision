import { describe, expect, it } from "vitest";
import {
  TransformersEmbeddingProvider,
  cosineSimilarity,
  createInMemoryDecisionEngine,
} from "../../src/index.ts";

const enabled = process.env.RUN_EMBEDDING_INTEGRATION === "1";

describe.skipIf(!enabled)("local Transformers integration", () => {
  it(
    "brings paraphrases closer together and keeps lexical negation near the affirmative form",
    async () => {
      const provider = new TransformersEmbeddingProvider();
      const [affirmative, paraphrase, negated, unrelated] = await provider.generateBatch([
        "The system allows cancelling appointments.",
        "Can an existing appointment be cancelled?",
        "Is it not possible to cancel an existing appointment?",
        "The capital of France is Paris.",
      ]);
      if (!affirmative || !paraphrase || !negated || !unrelated) {
        throw new Error("The local provider did not return the embeddings.");
      }

      const related = cosineSimilarity(affirmative, paraphrase);
      const negatedSimilarity = cosineSimilarity(affirmative, negated);
      const unrelatedSimilarity = cosineSimilarity(affirmative, unrelated);

      expect(related).toBeGreaterThan(unrelatedSimilarity);
      expect(negatedSimilarity).toBeGreaterThan(unrelatedSimilarity);

      const engine = createInMemoryDecisionEngine(provider);
      await engine.states.create({
        id: "salon",
        name: "Salon",
        knowledge: [
          {
            id: "k1",
            content: "The system allows cancelling appointments.",
            polarity: "positive",
          },
        ],
      });
      const affirmativeDecision = await engine.decide({
        stateId: "salon",
        questions: [
          {
            id: "yes",
            type: "noul",
            question: "Can an existing appointment be cancelled?",
          },
        ],
      });
      const negatedDecision = await engine.decide({
        stateId: "salon",
        questions: [
          {
            id: "no",
            type: "noul",
            question: "Is it not possible to cancel an existing appointment?",
          },
        ],
      });

      expect(affirmativeDecision.answers[0]?.decision).toBe(
        negatedDecision.answers[0]?.decision,
      );
    },
    180_000,
  );
});
