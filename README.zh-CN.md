# dancision

[English](README.md) | [Português](README.pt-BR.md) | [Español](README.es.md) | 中文

面向 Node.js 的语义决策框架。它接收一个 State、一个或多个问题，以及在需要时的候选项。决策来自嵌入向量、余弦相似度和阈值。没有生成式 LLM 解释问题、选择选项或给出分数。

## 安装

```bash
npm install dancision
```

核心不安装模型，也不安装数据库。适配器是可选依赖：

```bash
npm install @huggingface/transformers
npm install pg
```

需要 Node.js 20 或更高版本。

## 架构

```text
问题与选项
        |
        v
EmbeddingProvider  --->  查询时只对这些文本生成向量
        |
        v
VectorStore.search(stateId)  --->  已经保存的知识向量
        |
        v
DecisionStrategy (noul | choice | score | 自定义类型)
```

| 组件 | 职责 |
| --- | --- |
| `EmbeddingProvider` | 生成向量。核心不了解模型。 |
| `StateRepository` | 保存名称、描述、文本、极性、哈希和模型版本。 |
| `VectorStore` | 保存并检索向量，始终按 State 过滤。 |
| `StateManager` | 创建、更新、添加、删除和重新处理。协调两个存储。 |
| `DecisionEngine` | 为查询生成向量，取回证据，并分发给策略。 |
| `DecisionStrategy` | 对一种决策类型应用数学规则。 |

一次查询不会修改 State，也不会使用之前的回答。要更换模型或维度，调用 `states.reprocess(stateId)`。如果已保存的向量与当前 provider 不一致，查询会失败。

## State 与 Knowledge

State 是上下文。每条知识有自己的嵌入向量。整个 State 不会变成一个向量。

```typescript
await engine.states.create({
  id: "salon-erp",
  name: "美容院 ERP",
  description: "美容院管理系统",
  knowledge: [
    { id: "k1", content: "系统允许创建预约。", polarity: "positive" },
    { id: "k2", content: "系统允许取消预约。", polarity: "positive" },
    { id: "k3", content: "系统不允许周期性付款。", polarity: "negative" }
  ]
});
```

`polarity` 由编写知识的人提供：

- `positive`：文本肯定该能力或事实。
- `negative`：文本否定该能力或事实。
- `neutral`：会进入检索，但不投票。

极性不是从文本推断出来的。两段相近的文本可以有相反的极性。决策使用这个字段，而不是模型的直觉。

不同 State 的知识不会混在一起。检索始终收到 `stateId`。

操作：

- `states.create`
- `states.update`，用于名称和描述
- `states.addKnowledge`
- `states.updateKnowledge`，用于内容、极性或 metadata
- `states.removeKnowledge`
- `states.reprocess`
- `states.get`
- `states.delete`

只有在创建 State、添加知识、`content` 改变或调用 `reprocess` 时，才会重新生成知识的嵌入向量。只改极性会重写元数据并复用原向量。查询会为问题和选项描述生成嵌入向量。

每个向量保存 `modelId`、`dimensions` 和内容的 SHA-256 哈希。维度或模型不同时，查询会以 `IncompatibleDimensionsError` 或 `IncompatibleModelError` 中止。

## 嵌入向量

```typescript
interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  generate(text: string): Promise<number[]>;
  generateBatch?(texts: string[]): Promise<number[][]>;
}
```

`modelId` 进入缓存键，也用于和已保存向量比较。请包含模型和 dtype，或任何需要使旧向量失效的版本。

如果存在 `generateBatch`，尚未缓存的文本会在一次调用中送出。同一批次里的重复文本只嵌入一次。没有批量方法时，服务按顺序调用 `generate`。

`InMemoryEmbeddingCache` 是可选的。键是 `modelId` 加上文本哈希。缓存不能代替 VectorStore：已持久化的知识在查询时不会重新生成。

空向量、零向量、含非有限值的向量，或维度与声明不一致的向量，会在保存或比较之前被拒绝。

## 本地 Provider

`TransformersEmbeddingProvider` 只在第一次生成时加载 `@huggingface/transformers`。

```typescript
import { TransformersEmbeddingProvider } from "dancision";

const embeddings = new TransformersEmbeddingProvider({
  model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  dimensions: 384,
  dtype: "q8"
});
```

默认是该模型、384 维、mean pooling 和归一化向量。知识、问题和选项使用同一空间，没有 query 或 passage 前缀。如果更换模型，请把 `dimensions` 设为真实输出长度。张量与配置不一致时会抛出错误。`modelId` 的形式是 `{模型}:{dtype}`。

第一次使用会下载模型。这需要网络和磁盘空间。

## 自定义 Provider

实现该接口并注入引擎。`examples/custom-provider` 把词元分布到一个固定向量里。它用来展示契约，不是语义模型。

测试使用 `dancision/testing` 导出的 `DeterministicEmbeddingProvider`，并植入向量。决策可以在没有模型的情况下复现。

## PostgreSQL 与 pgvector

核心不导入 `pg`。可选子路径是 `dancision/pgvector`。

要求：

- 带有 `vector` 扩展的 PostgreSQL。
- pgvector 0.5 或更高版本，因为使用 HNSW 索引。
- 能够创建该扩展的角色，或者扩展已经创建。

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

第一次操作会在尚不存在时创建：

- `sde_states`，用 `jsonb` 保存 State 和知识列表。
- `sde_knowledge`，包含 `embedding vector(384)`、极性和哈希。
- 使用 `vector_cosine_ops` 的 HNSW 索引。

迁移是幂等的。它使用 `CREATE EXTENSION IF NOT EXISTS`、`CREATE TABLE IF NOT EXISTS` 和 `CREATE INDEX IF NOT EXISTS`。它不会 `DROP`，也不会 `ALTER` 向量列。如果表已经以另一种维度存在，操作会抛出 `SchemaMismatchError`，表保持原样。此时请使用另一个 `tablePrefix` 或另一个数据库。`vector(N)` 的维度在建表时固定。State 的新列通过 `ADD COLUMN` 和默认值加入。

检索按 `state_id` 和 `model_id` 过滤，按余弦距离排序，并接受 `limit`。schema 和前缀标识符只接受字母、数字和 `_`。

如果要自己管理连接池生命周期，也可以使用导出的 `createPgPool`。当连接池由该辅助函数创建时，`db.end()` 会关闭连接。

## 用法

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
      question: "已经预约的时间可以取消吗？"
    },
    {
      id: "action",
      type: "choice",
      question: "正在请求哪种预约操作？",
      options: [
        { id: "create", description: "创建预约" },
        { id: "cancel", description: "取消预约" },
        { id: "update", description: "修改预约" }
      ]
    }
  ]
});
```

下面的数字只是示意。相似度不是置信度，也不是概率。

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
          content: "系统允许取消预约。",
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

在 choice 中，`similarity` 是问题与选项描述之间的余弦。`rankingScore` 加上 State 的调整，可能超出 [-1, 1]。`evidenceScore` 是该调整的平均值。这些字段都不是概率。

每个回答还包含 `explanation`。

## 决策类型

### Noul

返回 `YES`、`NO` 或 `UNDETERMINED`。

1. 检索最多带回 State 中的 `topK` 条知识。
2. `similarity.positive` 和 `similarity.negative` 是每种极性的最大余弦，包括低于阈值的项。
3. 只有余弦大于或等于 `minSimilarity`、权重大于零、并且类别与问题匹配的项才投票。中性项不投票。相关性是余弦乘以权重。
4. 默认聚合对每一侧的相关性求和。`mean` 和 `peak` 是替代方式。和可以超过 1，它不是概率。
5. 如果问题带有 `polarity: "negative"`，两侧对调。没有该字段时，问题按肯定句处理。问题文本不会被分类。
6. 两侧都相关、优先级相同、又没有来源把它们分开时，结果是 `UNDETERMINED` / `CONTRADICTORY`。最高相似度不会选择一侧。
7. 更高的优先级，或 `prefer-source` 中更靠前的来源，保留投票。`conflictResolution: "margin"` 恢复旧规则：间隙小于 `contradictionMargin` 就是矛盾；否则，当间隙达到 `evidenceMargin` 时，较大的聚合获胜。
8. 空 State 产生 `NO_EVIDENCE`。检索到的项全部低于阈值时，产生 `INSUFFICIENT_EVIDENCE`。

缺少知识不是 `NO`。

问题上的 `polarity: "negative"` 用来让调用方声明这句话在询问否定。双重否定和复合逻辑关系不在本版本范围内。两条合格知识之间的 `contradicts` 关系也是冲突。没有优先级或来源把它们分开时，结果是 `UNDETERMINED`。

### Choice

把问题与每个选项描述比较。

- `base` 是问题与选项的余弦。
- 在通过阈值的问题知识中，`evidenceScore` 是余弦(选项, 知识)乘以极性符号后的平均值。没有证据时，调整为 0。
- `rankingScore = base + choiceEvidenceWeight * evidenceScore`。
- `SELECTED` 要求获胜选项的 `base >= minSimilarity`，并且它与第二名的 `rankingScore` 间隙大于或等于 `choiceMargin`。
- 间隙不足：`AMBIGUOUS`。
- 最佳 base 低于阈值：`WEAK_MATCH`。

知识可以改变顺序，但不会选出在语义上远离问题的选项。当边距分不开近义选项时，结果保持不确定。

### Score

刻度为 `{ min, max, step }`，要求 `min < max` 且 `step > 0`。

- 没有高于阈值的证据：`UNDETERMINED`。空 State 使用 `NO_EVIDENCE`。检索到但低于阈值的项使用 `INSUFFICIENT_EVIDENCE`。不填写数值。缺失不会变成 0。
- 没有优先级、来源或边距标准的矛盾：`UNDETERMINED` / `CONTRADICTORY`。
- 如果正侧因优先级或来源获胜，`raw = clamp(正侧聚合, 0, 1)`。
- 使用 `conflictResolution: "margin"` 时，`raw = clamp(正侧聚合 - 负侧聚合, 0, 1)`。
- 数值是 `min + raw * (max - min)`，再对齐到 `step`。

回答带有 `basis: "rescaled-cosine"`、`support` 和 `oppose`。这是对聚合或聚合间隙的重新缩放。它不是校准后的水平，不是概率，也不是统计置信度。更换模型会改变这些数字，即使 State 没有变化。

当负向证据因优先级或来源占优时，数值落在 `min`。这记录的是高于阈值的反对，而不是缺少知识。

## 阈值

默认值不是 MiniLM 的校准，也不是 50% 规则：

- `minSimilarity`：0.72
- `evidenceMargin`：0.05
- `contradictionMargin`：0.05
- `choiceMargin`：0.04
- `topK`：8
- `choiceEvidenceWeight`：0.15
- `aggregation`：`sum`
- `conflictResolution`：`priority`
- `relationWeight`：0

向构造函数传入部分对象即可。引擎测试使用植入向量和显式阈值。使用真实模型时，先测量释义、无关主题、相近选项以及正负知识对，再固定这些数字。

`topK` 限制决策能看到的范围。窗口之外的矛盾证据不进入计算。

`choiceEvidenceWeight` 为 0 时，排序选项会忽略 State。权重很高时，知识可以压过问题与选项之间的接近程度。被选中的选项仍然要经过 `minSimilarity`。

当 `conflictResolution` 为 `margin` 时，边距 0 会使零间隙不再算作矛盾。默认的 `priority` 下，两个相关侧会保持 `UNDETERMINED`，直到优先级或来源把它们分开。

## 结构化 State

同一个 State 可以回答多个问题，而不必重新发送知识。版本从 1 开始，每次变更加一。`decide` 不改变版本。

除了知识，State 还保存领域、元数据、类别、关系和约束。每条知识可以有类别、权重、优先级和来源。只改这些字段不会重新生成嵌入向量。

关系：`supports`、`contradicts`、`depends-on` 和 `refines`。当 `relationWeight` 大于零时，`supports` 提高目标的相关性。`contradicts` 打开冲突。另外两种只被记录，不改变投票。

约束：

- `minimum-evidence`：合格项的最少数量。
- `prefer-source`：有序来源列表。排在前面的获胜。
- `minimum-priority`：忽略低于下限的知识。

带有类别的约束只适用于与这些类别相交的问题。

## 证据、解释与策略

每个回答都带有 `explanation`：原问题、State 及其版本、模型、策略及其版本、阈值、取回的知识、有利证据、不利证据、冲突、计算、标准和最终结果。

决策不只使用余弦最高的那一条知识。内置策略包括余弦、加权相关性、聚合、极性、边距、规则，以及 Noul、Choice 和 Score 使用的混合组合。新策略实现 `type`、`version` 和 `decide`。

## 组合问题

`when` 引用同一次请求中更早的问题。如果那个决策不在 `decisions` 中，回答是 `SKIPPED` / `CONDITION_NOT_MET`，策略不会运行。这不会生成文本，也不会解释问题。

## 评估

`evaluateDecisions` 比较一组带标签的问题。`YES` 是精确率、召回率、假正率和假负率的正类。只有标签也是不确定时，`UNDETERMINED` 才算正确。不确定率单独计算。

`calibrateThresholds` 在同一集合上遍历网格。选出的阈值对该数据是乐观的。相似度不会变成概率。没有 Platt 校准。

## 审计

向引擎传入 `AuditLog`。`InMemoryAuditLog` 保存请求、响应、State 版本、模型、策略版本、参数和取回的知识。`replay` 用这些数据重新计算，不调用嵌入 provider，并报告自记录以来 State、模型或策略是否发生变化。

## 自定义策略

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
    { id: "q", type: "presence", question: "有相关知识吗？" }
  ]
});
```

同一 `type` 注册两次会抛出错误。`noul`、`choice` 和 `score` 已经注册。如果策略没有返回 `explanation`，引擎会保存一份只包含结果的最小解释。

上下文包含问题、问题向量、结构化 State、模型、相似度度量、带分数的知识、choice 选项向量和阈值。导出 `assessEvidence`、`judgeEvidence`、`vote`、`polarityPeaks` 和 `cosineSimilarity`。

新策略收到问题向量和证据。只有当 `type` 为 `choice` 时，选项描述才会自动嵌入。

## 示例

前四个示例不下载模型：

```bash
npm run example:basic
npm run example:salon
npm run example:states
npm run example:custom
```

`npm run example:salon-local` 使用本地 Transformers。它需要 `@huggingface/transformers` 并下载模型。数字会随模型变化。只写在问题里的否定不会被当作逻辑运算符。

## 测试

```bash
npm test
npm run build
```

单元测试植入向量，覆盖释义、不同词语映射到同一向量、负极性、矛盾、无关问题、空 State、相近选项、分开的选项、State 之间的隔离、不兼容的维度和不兼容的模型。它也覆盖低于阈值的假阳性，以及问题中的“不”字不会反转投票的情况。

本地模型集成默认关闭，直到：

```bash
RUN_EMBEDDING_INTEGRATION=1 npm test
```

它比较余弦区间。它不要求 MiniLM 给出某个精确决策。

## 限制

- 余弦衡量的是模型空间中的接近程度。它本身不能发现否定、因果或蕴含。当 State 中有极性或 `contradicts` 关系时，矛盾才会进入决策。
- 本版本不分类问题。需要反转投票的调用方应设置 `polarity: "negative"`。
- 中性知识不投票。没有显式极性的知识，应由了解领域的人存为 `positive`、`negative` 或 `neutral`。
- Score 是聚合或间隙的重新缩放。不要把这个数字当作置信度发布。
- 默认阈值只是起点。在同一测量集合上搜索阈值是乐观的。
- `topK` 可能隐藏较弱的证据。
- 本包不修改 Postgres 的 `vector(N)` 列。State 的新列通过 `ADD COLUMN` 和默认值加入。
- 本地 provider 较重，第一次运行会下载文件。确定性测试和示例不依赖它。

## 发布

包是 ESM，并为 `.`、`./pgvector` 和 `./testing` 提供 `types` 与 `exports`。`npm run build` 生成带声明文件的 `dist`。`@huggingface/transformers` 和 `pg` 保持为可选的 peer dependencies。
