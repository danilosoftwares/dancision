import {
  TransformersEmbeddingProvider,
  cosineSimilarity,
  createInMemoryDecisionEngine,
} from "../../src/index.ts";

const provider = new TransformersEmbeddingProvider();
const engine = createInMemoryDecisionEngine(provider);

const knowledge = "The system allows cancelling appointments.";
const affirmative = "Can an existing appointment be cancelled?";
const negated = "Is it not possible to cancel an existing appointment?";
const unrelated = "The capital of France is Paris.";

await engine.states.create({
  id: "salon-erp",
  name: "Beauty salon ERP",
  description: "Management system for beauty salons",
  knowledge: [
    { id: "k1", content: "The system allows creating appointments.", polarity: "positive" },
    { id: "k2", content: knowledge, polarity: "positive" },
    {
      id: "k3",
      content: "The system does not allow recurring payments.",
      polarity: "negative",
    },
  ],
});

const result = await engine.decide({
  stateId: "salon-erp",
  questions: [
    { id: "cancel", type: "noul", question: affirmative },
    {
      id: "cancel-negated",
      type: "noul",
      question: negated,
    },
    {
      id: "action",
      type: "choice",
      question: "Which scheduling operation is being requested?",
      options: [
        { id: "create", description: "Create appointment" },
        { id: "cancel", description: "Cancel appointment" },
        { id: "update", description: "Change appointment" },
      ],
    },
  ],
});

const [knowledgeVector, affirmativeVector, negatedVector, unrelatedVector] =
  await provider.generateBatch([knowledge, affirmative, negated, unrelated]);

if (!knowledgeVector || !affirmativeVector || !negatedVector || !unrelatedVector) {
  throw new Error("The local model did not return the embeddings.");
}

const comparison = {
  paraphrase: cosineSimilarity(knowledgeVector, affirmativeVector),
  negated: cosineSimilarity(knowledgeVector, negatedVector),
  unrelated: cosineSimilarity(knowledgeVector, unrelatedVector),
};

console.log(JSON.stringify({ comparison, result }, null, 2));

if (!(comparison.paraphrase > comparison.unrelated)) {
  throw new Error("The paraphrase should be closer to the knowledge than the unrelated text.");
}
if (!(comparison.negated > comparison.unrelated)) {
  throw new Error(
    "Lexical negation often stays close to the affirmative sentence. The model did not separate it even from the unrelated text.",
  );
}
