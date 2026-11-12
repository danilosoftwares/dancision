import { createInMemoryDecisionEngine } from "../../src/index.ts";
import { DeterministicEmbeddingProvider } from "../../src/testing/index.ts";

const allow = "The system allows creating appointments.";
const question = "Can an appointment be created?";

const provider = new DeterministicEmbeddingProvider({
  dimensions: 4,
  vectors: {
    [allow]: [0, 1, 0, 0],
    [question]: [0, 1, 0, 0],
  },
});

const engine = createInMemoryDecisionEngine(provider, {
  thresholds: {
    minSimilarity: 0.72,
    evidenceMargin: 0.05,
    contradictionMargin: 0.05,
  },
});

await engine.states.create({
  id: "demo",
  name: "Demonstration",
  knowledge: [{ id: "k1", content: allow, polarity: "positive" }],
});

const result = await engine.decide({
  stateId: "demo",
  questions: [{ id: "q1", type: "noul", question }],
});

console.log(JSON.stringify(result, null, 2));

if (result.answers[0]?.decision !== "YES") {
  throw new Error("The basic example expected the decision YES.");
}
