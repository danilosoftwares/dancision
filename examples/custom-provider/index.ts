import { createHash } from "node:crypto";
import {
  createInMemoryDecisionEngine,
  type EmbeddingProvider,
} from "../../src/index.ts";

class TokenHashEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = "token-hash-v1";
  readonly dimensions = 16;

  async generate(text: string): Promise<number[]> {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (const token of tokens) {
      const hash = createHash("sha256").update(token).digest();
      const index = hash[0] ?? 0;
      vector[index % this.dimensions] += 1;
    }
    if (vector.every((value) => value === 0)) {
      vector[0] = 1;
    }
    return vector;
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(await this.generate(text));
    }
    return vectors;
  }
}

const engine = createInMemoryDecisionEngine(new TokenHashEmbeddingProvider());

await engine.states.create({
  id: "custom",
  name: "Custom provider",
  knowledge: [
    {
      id: "k1",
      content: "The system allows cancelling appointments.",
      polarity: "positive",
    },
  ],
});

const result = await engine.decide({
  stateId: "custom",
  questions: [
    {
      id: "q1",
      type: "noul",
      question: "Can an existing appointment be cancelled?",
    },
  ],
});

console.log(JSON.stringify(result, null, 2));

const answer = result.answers[0];
if (!answer || answer.questionId !== "q1" || answer.type !== "noul") {
  throw new Error("The custom provider did not return the structured answer.");
}
if (answer.decision !== "UNDETERMINED" || answer.reason !== "INSUFFICIENT_EVIDENCE") {
  throw new Error(
    "The example provider is not a semantic model. With the default threshold, the paraphrase must stay undetermined.",
  );
}
