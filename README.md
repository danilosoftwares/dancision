# dancision

English | [Português](README.pt-BR.md) | [Español](README.es.md) | [中文](README.zh-CN.md)

Semantic decision framework for Node.js. It takes a State, one or more questions, and, when needed, answer options. The decision comes from embeddings, cosine similarity, and thresholds. No generative LLM interprets the question, picks the alternative, or assigns the score.

## Installation

```bash
npm install dancision
```

The core does not install a model or a database. The adapters are optional dependencies:

```bash
npm install @huggingface/transformers
npm install pg
```

Node.js 20 or later.

## Architecture

```text
questions and options
        |
        v
EmbeddingProvider  --->  only these texts are embedded during a query
        |
        v
VectorStore.search(stateId)  --->  knowledge vectors already stored
        |
        v
DecisionStrategy (noul | choice | score | custom type)
```

| Piece | Responsibility |
| --- | --- |
| `EmbeddingProvider` | Produces vectors. The core does not know the model. |
| `StateRepository` | Stores name, description, text, polarity, hash, and the model version. |
| `VectorStore` | Stores and searches vectors, always filtered by State. |
| `StateManager` | Creates, updates, adds, removes, and reprocesses. Coordinates both stores. |
| `DecisionEngine` | Embeds the query, retrieves evidence, and dispatches the strategy. |
| `DecisionStrategy` | Applies the mathematical rule for one decision type. |

A query does not change the State and does not use previous answers. To change the model or the dimension, call `states.reprocess(stateId)`. The query fails if the stored vectors do not match the current provider.

## State and Knowledge

The State is the context. Each knowledge item has its own embedding. The whole State is never one vector.

```typescript
await engine.states.create({
  id: "salon-erp",
  name: "Beauty salon ERP",
  description: "Management system for beauty salons",
  knowledge: [
    { id: "k1", content: "The system allows creating appointments.", polarity: "positive" },
    { id: "k2", content: "The system allows cancelling appointments.", polarity: "positive" },
    { id: "k3", content: "The system does not allow recurring payments.", polarity: "negative" }
  ]
});
```

`polarity` is supplied by whoever writes the knowledge:

- `positive`: the text affirms the capability or the fact.
- `negative`: the text denies the capability or the fact.
- `neutral`: it is retrieved, but it does not vote.

Polarity is not inferred from the text. Two nearby texts can have opposite polarities. The decision uses the field, not the model's intuition.

Knowledge from different States does not mix. Search always receives `stateId`.

Operations:

- `states.create`
- `states.update` for name and description
- `states.addKnowledge`
- `states.updateKnowledge` for content, polarity, or metadata
- `states.removeKnowledge`
- `states.reprocess`
- `states.get`
- `states.delete`

A knowledge embedding is generated again only when the State is created, a knowledge item is added, `content` changes, or `reprocess` is called. Changing only the polarity rewrites the metadata and reuses the vector. A query embeds the questions and the option descriptions.

Each vector stores `modelId`, `dimensions`, and the SHA-256 hash of the content. A different dimension or a different model stops the query with `IncompatibleDimensionsError` or `IncompatibleModelError`.

## Embeddings

```typescript
interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  generate(text: string): Promise<number[]>;
  generateBatch?(texts: string[]): Promise<number[][]>;
}
```

`modelId` is part of the cache key and of the comparison with stored vectors. Include the model and dtype, or any version that must invalidate old vectors.

If `generateBatch` exists, texts that are not cached yet go out in one call. Repeated texts in the same batch are embedded once. Without a batch method, the service calls `generate` in sequence.

`InMemoryEmbeddingCache` is optional. The key is `modelId` plus the text hash. The cache does not replace the VectorStore: persisted knowledge is not generated again during a query.

An empty, null, non-finite vector, or one whose dimension differs from the declared size, is rejected before it is stored or compared.

## Local provider

`TransformersEmbeddingProvider` loads `@huggingface/transformers` only on the first generation.

```typescript
import { TransformersEmbeddingProvider } from "dancision";

const embeddings = new TransformersEmbeddingProvider({
  model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  dimensions: 384,
  dtype: "q8"
});
```

The default is that model, 384 dimensions, mean pooling, and a normalized vector. The same space is used for knowledge, questions, and options, with no query or passage prefix. If you change the model, set `dimensions` to the real output size. A mismatch between the tensor and the configuration throws. `modelId` becomes `{model}:{dtype}`.

The first use downloads the model. That requires network access and disk space.

## Custom provider

Implement the interface and inject it into the engine. The `examples/custom-provider` example spreads tokens into a fixed vector. It shows the contract. It is not a semantic model.

Tests use `DeterministicEmbeddingProvider`, exported from `dancision/testing`, with planted vectors. The decision is reproducible without a model.

## PostgreSQL and pgvector

The core does not import `pg`. The optional subpath is `dancision/pgvector`.

Requirements:

- PostgreSQL with the `vector` extension.
- pgvector 0.5 or later, because of the HNSW index.
- A role that can create the extension, or the extension already created.

```typescript
import { DecisionEngine, TransformersEmbeddingProvider } from "dancision";
import { createPgPersistence } from "dancision/pgvector";

const persistence = await createPgPersistence({
  connectionString: process.env.DATABASE_URL ?? "",
  dimensions: 384,
  schema: "public",
  tablePrefix: "sde"
});

const engine = new DecisionEngine({
  embeddings: new TransformersEmbeddingProvider(),
  vectors: persistence.vectors,
  states: persistence.states
});
```

The first operation creates, if they do not exist yet:

- `sde_states`, with the State and the knowledge list in `jsonb`.
- `sde_knowledge`, with `embedding vector(384)`, polarity, and hash.
- an HNSW index using `vector_cosine_ops`.

The migration is idempotent. It uses `CREATE EXTENSION IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS`. It does not run `DROP` or `ALTER` the vector column. If the table already exists with another dimension, the operation throws `SchemaMismatchError` and the table stays as it is. In that case use another `tablePrefix` or another database. The `vector(N)` dimension is fixed when the table is created. New State columns are added with `ADD COLUMN` and a default value.

Search filters `state_id` and `model_id`, orders by cosine distance, and accepts `limit`. Schema and prefix identifiers accept only letters, digits, and `_`.

`createPgPool` is also exported if you want to control the pool lifecycle. `db.end()` closes the connection when the pool was created by that helper.

## Usage

```typescript
import {
  createInMemoryDecisionEngine,
  TransformersEmbeddingProvider
} from "dancision";

const engine = createInMemoryDecisionEngine(new TransformersEmbeddingProvider());

const result = await engine.decide({
  stateId: "salon-erp",
  questions: [
    {
      id: "cancel",
      type: "noul",
      question: "Can an existing appointment be cancelled?"
    },
    {
      id: "action",
      type: "choice",
      question: "Which scheduling operation is being requested?",
      options: [
        { id: "create", description: "Create appointment" },
        { id: "cancel", description: "Cancel appointment" },
        { id: "update", description: "Change appointment" }
      ]
    }
  ]
});
```

The numbers below are illustrative. Similarity is neither confidence nor probability.

```typescript
{
  stateId: "salon-erp",
  answers: [
    {
      questionId: "cancel",
      type: "noul",
      decision: "YES",
      value: true,
      similarity: { positive: 0.94, negative: 0.21 },
      evidence: [
        {
          knowledgeId: "k2",
          content: "The system allows cancelling appointments.",
          similarity: 0.94,
          polarity: "positive"
        }
      ]
    },
    {
      questionId: "action",
      type: "choice",
      decision: "SELECTED",
      selected: "cancel",
      alternatives: [
        { id: "create", similarity: 0.48, rankingScore: 0.48, evidenceScore: 0 },
        { id: "cancel", similarity: 0.94, rankingScore: 1.05, evidenceScore: 0.73 },
        { id: "update", similarity: 0.63, rankingScore: 0.63, evidenceScore: 0 }
      ],
      evidence: []
    }
  ]
}
```

In choice, `similarity` is the cosine between the question and the option description. `rankingScore` adds the State adjustment and can leave the interval [-1, 1]. `evidenceScore` is the mean of that adjustment. None of these fields is a probability.

Every answer also includes `explanation`.

## Decision types

### Noul

Returns `YES`, `NO`, or `UNDETERMINED`.

1. Search brings up to `topK` knowledge items from the State.
2. `similarity.positive` and `similarity.negative` are the highest cosines of each polarity, including items below the threshold.
3. An item votes only when its cosine is greater than or equal to `minSimilarity`, its weight is greater than zero, and its categories match the question. Neutral items do not vote. Relevance is cosine times weight.
4. The default aggregation sums the relevance of each side. `mean` and `peak` are alternatives. The sum can exceed 1 and is not a probability.
5. If the question arrives with `polarity: "negative"`, the sides swap. Without that field, the question is treated as affirmative. The question text is not classified.
6. When both sides are relevant, with the same priority and no source that separates them, the result is `UNDETERMINED` / `CONTRADICTORY`. The highest similarity does not choose the side.
7. Higher priority, or an earlier source in `prefer-source`, keeps the vote. `conflictResolution: "margin"` restores the older rule: a gap smaller than `contradictionMargin` is a contradiction; otherwise the larger aggregate wins if the gap reaches `evidenceMargin`.
8. An empty State produces `NO_EVIDENCE`. Retrieved items that are all below the threshold produce `INSUFFICIENT_EVIDENCE`.

Absence of knowledge is not `NO`.

`polarity: "negative"` on the question exists so the caller can declare that the sentence asks for the negation. Double negation and compound logical relations are out of scope for this version. A `contradicts` relation between two eligible knowledge items is also a conflict. Without priority or source to separate them, the result is `UNDETERMINED`.

### Choice

Compares the question with each option description.

- `base` is the question-option cosine.
- Among the question's knowledge items that passed the threshold, `evidenceScore` is the mean of cosine(option, knowledge) with the polarity sign. Without evidence, the adjustment is 0.
- `rankingScore = base + choiceEvidenceWeight * evidenceScore`.
- `SELECTED` requires the winning option to have `base >= minSimilarity` and the `rankingScore` gap to the second option to be greater than or equal to `choiceMargin`.
- Insufficient gap: `AMBIGUOUS`.
- Best base below the threshold: `WEAK_MATCH`.

Knowledge can change the order, but it does not select an option that is semantically far from the question. Near-synonym alternatives stay undetermined when the margin does not separate them.

### Score

Scale `{ min, max, step }`, with `min < max` and `step > 0`.

- No evidence above the threshold: `UNDETERMINED`. An empty State uses `NO_EVIDENCE`. Retrieved items below the threshold use `INSUFFICIENT_EVIDENCE`. The value is not filled. Absence does not become 0.
- A contradiction without a priority, source, or margin criterion: `UNDETERMINED` / `CONTRADICTORY`.
- If the positive side wins by priority or source, `raw = clamp(positive aggregate, 0, 1)`.
- With `conflictResolution: "margin"`, `raw = clamp(positive aggregate - negative aggregate, 0, 1)`.
- The value is `min + raw * (max - min)`, snapped to `step`.

The answer carries `basis: "rescaled-cosine"`, `support`, and `oppose`. That is a rescaling of the aggregate or of the gap between aggregates. It is not a calibrated level, not a probability, and not statistical confidence. Changing the model changes these numbers even when the State did not change.

When negative evidence wins by priority or source, the value sits on `min`. That records opposition above the threshold, not missing knowledge.

## Thresholds

The defaults are not a MiniLM calibration and not a 50% rule:

- `minSimilarity`: 0.72
- `evidenceMargin`: 0.05
- `contradictionMargin`: 0.05
- `choiceMargin`: 0.04
- `topK`: 8
- `choiceEvidenceWeight`: 0.15
- `aggregation`: `sum`
- `conflictResolution`: `priority`
- `relationWeight`: 0

Pass a partial object to the constructor. The engine tests use planted vectors and explicit thresholds. With a real model, measure paraphrases, unrelated topics, similar options, and positive/negative pairs before fixing the numbers.

`topK` limits what the decision sees. Contradictory evidence outside that window does not enter the calculation.

`choiceEvidenceWeight` 0 ignores the State when ranking options. A high weight lets knowledge overcome the proximity between question and option. The `minSimilarity` gate still applies to the selected option.

A margin of 0 stops a zero gap from being a contradiction when `conflictResolution` is `margin`. With the default `priority`, two relevant sides stay `UNDETERMINED` until priority or source separates them.

## Structured State

The same State answers several questions without resending the knowledge. The version starts at 1 and increases on every mutation. `decide` does not change the version.

Besides knowledge, the State stores domain, metadata, categories, relations, and constraints. Each knowledge item can have categories, weight, priority, and source. Changing only those fields does not generate an embedding again.

Relations: `supports`, `contradicts`, `depends-on`, and `refines`. When `relationWeight` is greater than zero, `supports` increases the target relevance. `contradicts` opens a conflict. The other two are recorded and do not change the vote.

Constraints:

- `minimum-evidence`: minimum number of eligible items.
- `prefer-source`: ordered list of sources. The first one wins.
- `minimum-priority`: ignores knowledge below the floor.

A constraint with categories applies only to a question that intersects those categories.

## Evidence, explanation, and strategies

Every answer carries `explanation`: question, State and version, model, strategy and version, thresholds, retrieved knowledge, favorable and contrary evidence, conflicts, calculations, criteria, and result.

The decision does not use only the item with the highest cosine. The built-in strategies are cosine, weighted relevance, aggregation, polarity, margin, rules, and the hybrid composition used by Noul, Choice, and Score. A new strategy implements `type`, `version`, and `decide`.

## Composite questions

`when` references an earlier question in the same request. If that decision is not in `decisions`, the answer is `SKIPPED` / `CONDITION_NOT_MET` and the strategy does not run. This does not generate text and does not interpret the question.

## Evaluation

`evaluateDecisions` compares a labeled set. `YES` is the positive class for precision, recall, false positives, and false negatives. `UNDETERMINED` is correct only when the label is also undetermined. The undetermined rate is separate.

`calibrateThresholds` walks a grid on the same set. The chosen threshold is optimistic for that data. Similarity does not become a probability. There is no Platt scaling.

## Audit

Pass an `AuditLog` to the engine. `InMemoryAuditLog` stores the request, the response, the State version, the model, the strategy versions, the thresholds, and the retrieved knowledge. `replay` recalculates from that data, without calling the embedding provider, and reports whether the State, model, or strategy changed since the record.

## Custom strategy

```typescript
import type { DecisionStrategy } from "dancision";

const presence: DecisionStrategy = {
  type: "presence",
  version: "1.0.0",
  decide(context) {
    return {
      questionId: context.question.id,
      type: "presence",
      decision: context.knowledge.length > 0 ? "PRESENT" : "EMPTY",
      evidence: []
    };
  }
};

engine.registerStrategy(presence);

await engine.decide({
  stateId: "salon-erp",
  questions: [
    { id: "q", type: "presence", question: "Is there related knowledge?" }
  ]
});
```

Registering the same `type` twice throws. `noul`, `choice`, and `score` are already registered. If the strategy does not return `explanation`, the engine stores a minimal explanation with the result.

The context carries the question, the question vector, the structured State, the model, the similarity measure, the scored knowledge, the choice option vectors, and the thresholds. `assessEvidence`, `judgeEvidence`, `vote`, `polarityPeaks`, and `cosineSimilarity` are exported.

A new strategy receives the question vector and the evidence. Option descriptions are embedded automatically only when `type` is `choice`.

## Examples

The first four run without downloading a model:

```bash
npm run example:basic
npm run example:salon
npm run example:states
npm run example:custom
```

`npm run example:salon-local` uses the local Transformers provider. It requires `@huggingface/transformers` and the model download. The numbers vary with the model. Negation written only in the question is not treated as a logical operator.

## Tests

```bash
npm test
npm run build
```

The unit suite plants vectors and covers paraphrase, different words with the same vector, negative polarity, contradiction, an unrelated question, an empty State, similar alternatives, separated alternatives, isolation between States, incompatible dimension, and incompatible model. It also covers a false positive below the threshold and the case where the word "no" in the question does not invert the vote.

Integration with the local model stays off until:

```bash
RUN_EMBEDDING_INTEGRATION=1 npm test
```

It compares cosine ranges. It does not require an exact MiniLM decision.

## Limitations

- Cosine measures proximity in the model space. It does not by itself discover negation, cause, or implication. Contradiction enters when polarity or a `contradicts` relation is in the State.
- This version does not classify the question. Callers who need the inverted vote set `polarity: "negative"`.
- Neutral knowledge does not vote. Knowledge without an explicit polarity must be stored as `positive`, `negative`, or `neutral` by someone who knows the domain.
- Score is a rescaling of an aggregate or a gap. Do not publish that number as confidence.
- The default thresholds are a starting point. A calibration grid on the same set used to measure is optimistic.
- `topK` can hide weaker evidence.
- This package does not alter the Postgres `vector(N)` column. New State columns are added with `ADD COLUMN` and a default value.
- The local provider is heavy and downloads files on the first run. Deterministic tests and examples do not depend on it.

## Publishing

The package is ESM, with `types` and `exports` for `.`, `./pgvector`, and `./testing`. `npm run build` generates `dist` with declarations. `@huggingface/transformers` and `pg` stay optional peer dependencies.
