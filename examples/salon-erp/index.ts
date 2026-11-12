import { createInMemoryDecisionEngine } from "../../src/index.ts";
import { DeterministicEmbeddingProvider } from "../../src/testing/index.ts";

const allowCancel = "The system allows cancelling appointments.";
const allowCreate = "The system allows creating appointments.";
const denyRecurring = "The system does not allow recurring payments.";
const askCancel = "Can an existing appointment be cancelled?";
const askAction = "Which scheduling operation is being requested?";
const createOption = "Create appointment";
const cancelOption = "Cancel appointment";
const updateOption = "Change appointment";

const provider = new DeterministicEmbeddingProvider({
  dimensions: 4,
  vectors: {
    [allowCancel]: [1, 0, 0, 0],
    [allowCreate]: [0, 1, 0, 0],
    [denyRecurring]: [0, 0, 1, 0],
    [askCancel]: [1, 0, 0, 0],
    [askAction]: [1, 0, 0, 0],
    [createOption]: [0, 1, 0, 0],
    [cancelOption]: [1, 0, 0, 0],
    [updateOption]: [0, 0, 1, 0],
  },
});

const engine = createInMemoryDecisionEngine(provider);

await engine.states.create({
  id: "salon-erp",
  name: "Beauty salon ERP",
  description: "Management system for beauty salons",
  knowledge: [
    { id: "k1", content: allowCreate, polarity: "positive" },
    { id: "k2", content: allowCancel, polarity: "positive" },
    { id: "k3", content: denyRecurring, polarity: "negative" },
  ],
});

const result = await engine.decide({
  stateId: "salon-erp",
  questions: [
    { id: "cancel", type: "noul", question: askCancel },
    {
      id: "action",
      type: "choice",
      question: askAction,
      options: [
        { id: "create", description: createOption },
        { id: "cancel", description: cancelOption },
        { id: "update", description: updateOption },
      ],
    },
  ],
});

console.log(JSON.stringify(result, null, 2));

const [cancel, action] = result.answers;
if (cancel?.decision !== "YES" || action?.decision !== "SELECTED" || action.selected !== "cancel") {
  throw new Error("The salon example expected YES for cancellation and the cancel option.");
}
