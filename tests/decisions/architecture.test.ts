import { describe, expect, it } from "vitest";
import {
  DecisionEngine,
  InMemoryAuditLog,
  InMemoryStateRepository,
  InMemoryVectorStore,
  InvalidDecisionError,
  calibrateThresholds,
  evaluateDecisions,
  type NoulAnswer,
} from "../../src/index.ts";
import { createEngine, createProvider, SpyProvider, text, vector } from "../helpers/fixtures.ts";

const opposed = [0.8, 0.6, 0, 0];
const weaker = [0.76, Math.sqrt(1 - 0.76 * 0.76), 0, 0];
const secondPositive = "Cancellation is available in this module.";
const reservedPositive = "The system allows cancelling with a caveat.";

describe("contextual engine", () => {
  it("keeps domain, version, and attributes without reprocessing the embedding", async () => {
    const embeddings = new SpyProvider(
      createProvider({
        [text.allowCancel]: vector.cancel,
        [text.askCancel]: vector.cancel,
      }),
    );
    const engine = new DecisionEngine({
      embeddings,
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
    });
    const created = await engine.states.create({
      id: "salon",
      name: "Salon",
      domain: "scheduling",
      metadata: { owner: "ana" },
      categories: ["scheduling"],
      knowledge: [
        {
          id: "k1",
          content: text.allowCancel,
          polarity: "positive",
          weight: 1,
          priority: 1,
          source: "policy",
          categories: ["scheduling"],
        },
      ],
    });
    embeddings.calls.length = 0;

    const decided = await engine.decide({
      stateId: "salon",
      questions: [{ id: "q1", type: "noul", question: text.askCancel }],
    });
    const afterDecision = await engine.states.get("salon");
    const updated = await engine.states.updateKnowledge("salon", "k1", { priority: 4 });

    expect(created.version).toBe(1);
    expect(created.domain).toBe("scheduling");
    expect(afterDecision.version).toBe(1);
    expect(updated.version).toBe(2);
    expect(updated.knowledge[0]?.priority).toBe(4);
    expect(embeddings.calls).toEqual([text.askCancel]);
    const answer = decided.answers[0] as NoulAnswer;
    expect(answer.decision).toBe("YES");
    expect(answer.explanation.stateVersion).toBe(1);
    expect(answer.explanation.strategy).toEqual({ type: "noul", version: "1.1.0" });
    expect(answer.explanation.question).toBe(text.askCancel);
    expect(answer.explanation.calculations.length).toBeGreaterThan(0);
    expect(answer.evidence[0]?.relevance).toBeCloseTo(1);
  });

  it("lets priority beat a higher similarity", async () => {
    const answer = await decideNoul(
      {
        [text.allowCancel]: opposed,
        [text.denyCancel]: vector.cancel,
        [text.askCancel]: vector.cancel,
      },
      {
        knowledge: [
          { id: "k-yes", content: text.allowCancel, polarity: "positive", priority: 5 },
          { id: "k-no", content: text.denyCancel, polarity: "negative", priority: 0 },
        ],
      },
    );

    expect(answer.similarity.negative).toBeCloseTo(1);
    expect(answer.similarity.positive).toBeCloseTo(0.8);
    expect(answer.decision).toBe("YES");
    expect(answer.evidence.map((item) => item.knowledgeId)).toEqual(["k-yes"]);
    expect(answer.explanation.conflicts[0]?.resolved).toBe(true);
    expect(answer.explanation.conflicts[0]?.resolution).toBe("priority");
  });

  it("uses the preferred source before priority", async () => {
    const answer = await decideNoul(
      {
        [text.allowCancel]: opposed,
        [text.denyCancel]: vector.cancel,
        [text.askCancel]: vector.cancel,
      },
      {
        constraints: [
          {
            id: "source",
            description: "Institutional policy prevails.",
            kind: "prefer-source",
            sources: ["policy", "operations"],
          },
        ],
        knowledge: [
          {
            id: "k-yes",
            content: text.allowCancel,
            polarity: "positive",
            priority: 0,
            source: "policy",
          },
          {
            id: "k-no",
            content: text.denyCancel,
            polarity: "negative",
            priority: 9,
            source: "operations",
          },
        ],
      },
    );

    expect(answer.decision).toBe("YES");
    expect(answer.explanation.conflicts[0]?.resolution).toBe("source");
  });

  it("treats a contradicts relation without a criterion as undetermined", async () => {
    const unresolved = await decideNoul(
      {
        [text.allowCancel]: vector.cancel,
        [secondPositive]: vector.cancel,
        [text.askCancel]: vector.cancel,
      },
      {
        knowledge: [
          { id: "k1", content: text.allowCancel, polarity: "positive" },
          { id: "k2", content: secondPositive, polarity: "positive" },
        ],
        relations: [{ id: "r1", from: "k1", to: "k2", type: "contradicts" }],
      },
    );
    const resolved = await decideNoul(
      {
        [text.allowCancel]: vector.cancel,
        [secondPositive]: vector.cancel,
        [text.askCancel]: vector.cancel,
      },
      {
        knowledge: [
          { id: "k1", content: text.allowCancel, polarity: "positive", priority: 0 },
          { id: "k2", content: secondPositive, polarity: "positive", priority: 2 },
        ],
        relations: [{ id: "r1", from: "k1", to: "k2", type: "contradicts" }],
      },
    );

    expect(unresolved.decision).toBe("UNDETERMINED");
    expect(unresolved.reason).toBe("CONTRADICTORY");
    expect(resolved.decision).toBe("YES");
    expect(resolved.evidence.map((item) => item.knowledgeId)).toEqual(["k2"]);
  });

  it("aggregates several pieces of evidence when margin resolution is configured", async () => {
    const vectors = {
      [reservedPositive]: opposed,
      [secondPositive]: opposed,
      [text.denyCancel]: weaker,
      [text.askCancel]: vector.cancel,
    };
    const knowledge = [
      { id: "k1", content: reservedPositive, polarity: "positive" as const },
      { id: "k2", content: secondPositive, polarity: "positive" as const },
      { id: "k-no", content: text.denyCancel, polarity: "negative" as const },
    ];
    const summed = await decideNoul(vectors, {
      knowledge,
      thresholds: { aggregation: "sum", conflictResolution: "margin" },
    });
    const peaked = await decideNoul(vectors, {
      knowledge,
      thresholds: { aggregation: "peak", conflictResolution: "margin" },
    });

    expect(summed.decision).toBe("YES");
    expect(peaked.decision).toBe("UNDETERMINED");
    expect(peaked.reason).toBe("CONTRADICTORY");
  });

  it("filters by category, requires a minimum count, and ignores zero weight", async () => {
    const outside = await decideNoul(
      {
        [text.allowCancel]: vector.cancel,
        [text.askCancel]: vector.cancel,
      },
      {
        knowledge: [
          {
            id: "k1",
            content: text.allowCancel,
            polarity: "positive",
            categories: ["billing"],
          },
        ],
        categories: ["scheduling"],
      },
    );
    const tooFew = await decideNoul(
      {
        [text.allowCancel]: vector.cancel,
        [text.askCancel]: vector.cancel,
      },
      {
        knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
        constraints: [
          {
            id: "minimum",
            description: "Requires two pieces of evidence.",
            kind: "minimum-evidence",
            minEvidence: 2,
          },
        ],
      },
    );
    const silent = await decideNoul(
      {
        [text.allowCancel]: vector.cancel,
        [text.askCancel]: vector.cancel,
      },
      {
        knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive", weight: 0 }],
      },
    );

    expect(outside.decision).toBe("UNDETERMINED");
    expect(outside.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(tooFew.reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(silent.reason).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("skips a dependent question and rejects a forward dependency", async () => {
    const { engine } = createEngine({
      [text.allowCancel]: vector.cancel,
      [text.askCancel]: vector.cancel,
      [text.askCreate]: vector.create,
    });
    engine.registerStrategy({
      type: "boom",
      version: "1.0.0",
      decide() {
        throw new Error("the condition blocked this strategy");
      },
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });

    const result = await engine.decide({
      stateId: "salon",
      questions: [
        { id: "has", type: "noul", question: text.askCancel },
        {
          id: "cancel",
          type: "noul",
          question: text.askCancel,
          when: { questionId: "has", decisions: ["YES"] },
        },
        {
          id: "blocked",
          type: "boom",
          question: text.askCreate,
          when: { questionId: "has", decisions: ["NO"] },
        },
      ],
    });

    expect(result.answers.map((answer) => answer.decision)).toEqual(["YES", "YES", "SKIPPED"]);
    expect(result.answers[2]?.reason).toBe("CONDITION_NOT_MET");
    await expect(
      engine.decide({
        stateId: "salon",
        questions: [
          {
            id: "later",
            type: "noul",
            question: text.askCancel,
            when: { questionId: "missing", decisions: ["YES"] },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidDecisionError);
  });

  it("reproduces the stored decision after the State changes", async () => {
    const embeddings = createProvider({
      [text.allowCancel]: vector.cancel,
      [text.allowCreate]: vector.create,
      [text.askCancel]: vector.cancel,
    });
    const audit = new InMemoryAuditLog();
    const engine = new DecisionEngine({
      embeddings,
      vectors: new InMemoryVectorStore(),
      states: new InMemoryStateRepository(),
      audit,
    });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [{ id: "k1", content: text.allowCancel, polarity: "positive" }],
    });
    await engine.decide({
      stateId: "salon",
      questions: [{ id: "q1", type: "noul", question: text.askCancel }],
    });
    await engine.states.addKnowledge("salon", {
      id: "k2",
      content: text.allowCreate,
      polarity: "positive",
    });

    const [record] = await audit.list("salon");
    if (!record) {
      throw new Error("missing audit record");
    }
    const report = await engine.replay(record.id);

    expect(report.decisionsMatch).toBe(true);
    expect(report.modelMatches).toBe(true);
    expect(report.strategyVersionsMatch).toBe(true);
    expect(report.stateVersionMatches).toBe(false);
    expect(report.storedStateVersion).toBe(1);
    expect(report.currentStateVersion).toBe(2);
    expect(report.replayed.answers[0]?.decision).toBe("YES");
  });

  it("measures the labeled set and picks the threshold by F1", async () => {
    const embeddings = createProvider({
      [text.allowCancel]: vector.cancel,
      [text.denyCancel]: vector.update,
      [text.askCancel]: opposed,
      [text.unrelated]: vector.unrelated,
    });
    const vectors = new InMemoryVectorStore();
    const states = new InMemoryStateRepository();
    const engine = new DecisionEngine({ embeddings, vectors, states });
    await engine.states.create({
      id: "salon",
      name: "Salon",
      knowledge: [
        { id: "k-yes", content: text.allowCancel, polarity: "positive" },
        { id: "k-no", content: text.denyCancel, polarity: "negative" },
      ],
    });
    const positive = {
      id: "expected-yes",
      questions: [{ id: "q", type: "noul" as const, question: text.askCancel }],
      questionId: "q",
      expected: { decision: "YES" },
    };
    const negative = {
      id: "expected-no",
      questions: [
        { id: "q", type: "noul" as const, question: text.askCancel, polarity: "negative" as const },
      ],
      questionId: "q",
      expected: { decision: "NO" },
    };
    const unrelated = {
      id: "unrelated",
      questions: [{ id: "q", type: "noul" as const, question: text.unrelated }],
      questionId: "q",
      expected: { decision: "YES" },
    };

    const report = await evaluateDecisions(engine, "salon", [positive, negative, unrelated]);
    const calibration = await calibrateThresholds({
      embeddings,
      vectors,
      states,
      stateId: "salon",
      cases: [positive],
      grid: { minSimilarity: [0.72, 0.9] },
    });

    expect(report.accuracy).toBeCloseTo(2 / 3);
    expect(report.precision).toBeCloseTo(1);
    expect(report.recall).toBeCloseTo(0.5);
    expect(report.f1).toBeCloseTo(2 / 3);
    expect(report.falsePositiveRate).toBeCloseTo(0);
    expect(report.falseNegativeRate).toBeCloseTo(0.5);
    expect(report.undeterminedRate).toBeCloseTo(1 / 3);
    expect(report.methodology).toContain("is not a probability");
    expect(calibration.selected.minSimilarity).toBe(0.72);
    expect(calibration.selectedMetrics.f1).toBe(1);
    expect(calibration.methodology).toContain("optimistic");
    expect(calibration.methodology).toContain("Platt");
  });
});

async function decideNoul(
  vectors: Record<string, number[]>,
  input: {
    knowledge: {
      id: string;
      content: string;
      polarity: "positive" | "negative";
      priority?: number;
      source?: string;
      weight?: number;
      categories?: string[];
    }[];
    relations?: { id: string; from: string; to: string; type: "contradicts" }[];
    constraints?: {
      id: string;
      description: string;
      kind: "prefer-source" | "minimum-evidence";
      sources?: string[];
      minEvidence?: number;
    }[];
    categories?: string[];
    thresholds?: { aggregation?: "sum" | "peak"; conflictResolution?: "margin" | "priority" };
  },
): Promise<NoulAnswer> {
  const { engine } = createEngine(vectors, {
    ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
  });
  await engine.states.create({
    id: "salon",
    name: "Salon",
    ...(input.categories === undefined ? {} : { categories: input.categories }),
    ...(input.relations === undefined ? {} : { relations: input.relations }),
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    knowledge: input.knowledge,
  });
  const result = await engine.decide({
    stateId: "salon",
    questions: [
      {
        id: "q1",
        type: "noul",
        question: text.askCancel,
        ...(input.categories === undefined ? {} : { categories: input.categories }),
      },
    ],
  });
  return result.answers[0] as NoulAnswer;
}
