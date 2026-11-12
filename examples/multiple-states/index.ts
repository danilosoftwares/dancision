import { createInMemoryDecisionEngine } from "../../src/index.ts";
import { DeterministicEmbeddingProvider } from "../../src/testing/index.ts";

const salonKnowledge = "The system allows cancelling appointments.";
const clinicKnowledge = "The clinic records medical charts.";
const question = "Can an existing appointment be cancelled?";

const provider = new DeterministicEmbeddingProvider({
  dimensions: 4,
  vectors: {
    [salonKnowledge]: [1, 0, 0, 0],
    [clinicKnowledge]: [0, 0, 1, 0],
    [question]: [1, 0, 0, 0],
  },
});

const engine = createInMemoryDecisionEngine(provider);

await engine.states.create({
  id: "salon-erp",
  name: "Salon ERP",
  knowledge: [{ id: "k1", content: salonKnowledge, polarity: "positive" }],
});

await engine.states.create({
  id: "clinic-erp",
  name: "Clinic ERP",
  knowledge: [{ id: "k1", content: clinicKnowledge, polarity: "positive" }],
});

const salon = await engine.decide({
  stateId: "salon-erp",
  questions: [{ id: "q", type: "noul", question }],
});
const clinic = await engine.decide({
  stateId: "clinic-erp",
  questions: [{ id: "q", type: "noul", question }],
});

console.log(JSON.stringify({ salon, clinic }, null, 2));

if (salon.answers[0]?.decision !== "YES" || clinic.answers[0]?.decision !== "UNDETERMINED") {
  throw new Error("The States should answer in isolation.");
}
