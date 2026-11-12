# dancision

[English](README.md) | Português | [Español](README.es.md) | [中文](README.zh-CN.md)

Framework de decisão semântica para Node.js. Ele recebe um State, uma ou mais perguntas e, quando cabe, opções de resposta. A decisão sai de embeddings, similaridade de cosseno e limiares. Não há LLM generativa interpretando a pergunta, escolhendo a alternativa ou atribuindo o score.

## Instalação

```bash
npm install dancision
```

O núcleo não instala modelo nem banco. Os adapters são dependências opcionais:

```bash
npm install @huggingface/transformers
npm install pg
```

Node.js 20 ou superior.

## Arquitetura

```text
perguntas e opções
        |
        v
EmbeddingProvider  --->  só estes textos são vetorizados na consulta
        |
        v
VectorStore.search(stateId)  --->  vetores de conhecimento já gravados
        |
        v
DecisionStrategy (noul | choice | score | tipo próprio)
```

| Peça | Responsabilidade |
| --- | --- |
| `EmbeddingProvider` | Gera vetores. O núcleo não conhece o modelo. |
| `StateRepository` | Guarda nome, descrição, texto, polaridade, hash e a versão do modelo. |
| `VectorStore` | Guarda e busca vetores, sempre filtrando por State. |
| `StateManager` | Cria, atualiza, adiciona, remove e reprocessa. Coordena os dois armazenamentos. |
| `DecisionEngine` | Embute a consulta, recupera evidências e despacha a estratégia. |
| `DecisionStrategy` | Aplica a regra matemática de um tipo de decisão. |

Uma consulta não altera o State e não usa respostas anteriores. Para trocar o modelo ou a dimensão, chame `states.reprocess(stateId)`. A consulta falha se os vetores gravados não baterem com o provider atual.

## State e Knowledge

O State é o contexto. Cada conhecimento tem embedding próprio. O State inteiro não vira um único vetor.

```typescript
await engine.states.create({
  id: "salon-erp",
  name: "ERP para salão de beleza",
  description: "Sistema de gestão para salões de beleza",
  knowledge: [
    { id: "k1", content: "O sistema permite criar agendamentos.", polarity: "positive" },
    { id: "k2", content: "O sistema permite cancelar agendamentos.", polarity: "positive" },
    { id: "k3", content: "O sistema não permite pagamentos recorrentes.", polarity: "negative" }
  ]
});
```

`polarity` é informada por quem escreve o conhecimento:

- `positive`: o texto afirma a capacidade ou o fato.
- `negative`: o texto nega a capacidade ou o fato.
- `neutral`: entra na busca, mas não vota.

A polaridade não é deduzida do texto. Dois textos próximos podem ter polaridades opostas. A decisão usa o campo, não a intuição do modelo.

Conhecimentos de States diferentes não se misturam. A busca sempre recebe `stateId`.

Operações:

- `states.create`
- `states.update` para nome e descrição
- `states.addKnowledge`
- `states.updateKnowledge` para conteúdo, polaridade ou metadata
- `states.removeKnowledge`
- `states.reprocess`
- `states.get`
- `states.delete`

O embedding do conhecimento é gerado de novo apenas quando o State é criado, um conhecimento é adicionado, o `content` muda ou `reprocess` é chamado. Mudar só a polaridade regrava o metadado e reutiliza o vetor. A consulta gera embeddings das perguntas e das descrições de opções.

Cada vetor guarda `modelId`, `dimensions` e o hash SHA-256 do conteúdo. Dimensão diferente ou modelo diferente interrompe a consulta com `IncompatibleDimensionsError` ou `IncompatibleModelError`.

## Embeddings

```typescript
interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  generate(text: string): Promise<number[]>;
  generateBatch?(texts: string[]): Promise<number[][]>;
}
```

O `modelId` entra na chave do cache e na comparação com os vetores gravados. Inclua modelo e dtype, ou qualquer versão que precise invalidar os vetores antigos.

Se `generateBatch` existir, os textos ainda não cacheados saem numa chamada só. Textos repetidos no mesmo lote são embutidos uma vez. Sem lote, o serviço chama `generate` em sequência.

`InMemoryEmbeddingCache` é opcional. A chave é `modelId` mais o hash do texto. O cache não substitui o VectorStore: conhecimento persistido não é gerado outra vez na consulta.

Vetor vazio, nulo, não finito ou com dimensão diferente da declarada é recusado antes de ser gravado ou comparado.

## Provider local

`TransformersEmbeddingProvider` carrega `@huggingface/transformers` só na primeira geração.

```typescript
import { TransformersEmbeddingProvider } from "dancision";

const embeddings = new TransformersEmbeddingProvider({
  model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  dimensions: 384,
  dtype: "q8"
});
```

O padrão é esse modelo, 384 dimensões, pooling mean e vetor normalizado. O mesmo espaço vale para conhecimento, pergunta e opção, sem prefixo de query e passage. Se trocar o modelo, informe `dimensions` com o tamanho real da saída. Uma divergência entre o tensor e a configuração lança erro. O `modelId` fica `{modelo}:{dtype}`.

O primeiro uso baixa o modelo. Isso exige rede e espaço em disco.

## Provider próprio

Implemente a interface e injete na engine. O exemplo `examples/custom-provider` distribui tokens num vetor fixo. Serve para mostrar o contrato, não como modelo semântico.

Testes usam `DeterministicEmbeddingProvider`, exportado em `dancision/testing`, com vetores plantados. A decisão é reproduzível sem modelo.

## PostgreSQL e pgvector

O núcleo não importa `pg`. O subpath opcional é `dancision/pgvector`.

Requisitos:

- PostgreSQL com a extensão `vector`.
- pgvector 0.5 ou superior, por causa do índice HNSW.
- Um papel que possa criar a extensão, ou a extensão já criada.

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

A primeira operação cria, se ainda não existirem:

- `sde_states`, com o State e a lista de conhecimentos em `jsonb`.
- `sde_knowledge`, com `embedding vector(384)`, polaridade e hash.
- um índice HNSW `vector_cosine_ops`.

A migração é idempotente. Ela usa `CREATE EXTENSION IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS` e `CREATE INDEX IF NOT EXISTS`. Não executa `DROP` nem `ALTER` da coluna vetorial. Se a tabela já existir com outra dimensão, a operação lança `SchemaMismatchError` e a tabela permanece como está. Nesse caso use outro `tablePrefix` ou outro banco. A dimensão de `vector(N)` fica fixa na criação da tabela.

A busca filtra `state_id` e `model_id`, ordena pela distância de cosseno e aceita `limit`. Identificadores de schema e prefixo só aceitam letras, números e `_`.

`createPgPool` também está exportado, se quiser controlar o ciclo do pool. `db.end()` encerra a conexão quando o pool foi criado por esse helper.

## Uso

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
      question: "É possível cancelar um horário já agendado?"
    },
    {
      id: "action",
      type: "choice",
      question: "Qual operação de agendamento está sendo solicitada?",
      options: [
        { id: "create", description: "Criar agendamento" },
        { id: "cancel", description: "Cancelar agendamento" },
        { id: "update", description: "Alterar agendamento" }
      ]
    }
  ]
});
```

Os números abaixo são ilustrativos. Similaridade não é confiança nem probabilidade.

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
          content: "O sistema permite cancelar agendamentos.",
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

`similarity` no choice é o cosseno entre a pergunta e a descrição da opção. `rankingScore` soma o ajuste do State e pode sair do intervalo \[-1, 1\]. `evidenceScore` é a média desse ajuste. Nenhum desses campos é probabilidade.

## Tipos de decisão

### Noul

Responde `YES`, `NO` ou `UNDETERMINED`.

1. A busca traz até `topK` conhecimentos do State.
2. `similarity.positive` e `similarity.negative` são os maiores cossenos de cada polaridade, inclusive abaixo do limiar.
3. Só vota item com cosseno maior ou igual a `minSimilarity`, peso maior que zero e categoria compatível com a pergunta. Neutro não vota. Relevância é cosseno vezes peso.
4. A agregação padrão soma as relevâncias de cada lado. `mean` e `peak` são alternativas. A soma pode passar de 1 e não é probabilidade.
5. Se a pergunta vier com `polarity: "negative"`, os lados trocam. Sem esse campo, a pergunta é tratada como afirmativa. O texto da pergunta não é classificado.
6. Os dois lados relevantes, com a mesma prioridade e sem origem que os separe, geram `UNDETERMINED` / `CONTRADICTORY`. A maior similaridade não escolhe o lado.
7. Prioridade maior, ou origem anterior em `prefer-source`, fica com o voto. `conflictResolution: "margin"` restaura a regra antiga: folga menor que `contradictionMargin` é contradição; caso contrário, o agregado maior vence se a folga atingir `evidenceMargin`.
8. State vazio gera `NO_EVIDENCE`. Itens recuperados, mas todos abaixo do limiar, geram `INSUFFICIENT_EVIDENCE`.

Ausência de conhecimento não é `NO`.

`polarity: "negative"` na pergunta existe para o chamador declarar que a frase pede a negação. Dupla negação e relações lógicas compostas ficam fora desta versão. Uma relação `contradicts` entre dois conhecimentos elegíveis também é conflito. Sem prioridade ou origem que separe os dois, o resultado é `UNDETERMINED`.

### Choice

Compara a pergunta com cada descrição de opção.

- `base` é o cosseno pergunta-opção.
- Entre os conhecimentos da pergunta que passaram do limiar, `evidenceScore` é a média de cosseno(opção, conhecimento) com sinal da polaridade. Sem evidência, o ajuste é 0.
- `rankingScore = base + choiceEvidenceWeight * evidenceScore`.
- `SELECTED` exige que a opção vencedora tenha `base >= minSimilarity` e que a folga de `rankingScore` para a segunda seja maior ou igual a `choiceMargin`.
- Folga insuficiente: `AMBIGUOUS`.
- Melhor base abaixo do limiar: `WEAK_MATCH`.

O conhecimento pode mudar a ordem, mas não escolhe uma opção semanticamente distante da pergunta. Alternativas quase sinônimas permanecem indeterminadas quando a margem não as separa.

### Score

Escala `{ min, max, step }`, com `min < max` e `step > 0`.

- Sem evidência acima do limiar: `UNDETERMINED`. State vazio usa `NO_EVIDENCE`. Itens recuperados abaixo do limiar usam `INSUFFICIENT_EVIDENCE`. O valor não é preenchido. Ausência não vira 0.
- Contradição sem critério de prioridade, origem ou margem: `UNDETERMINED` / `CONTRADICTORY`.
- Se o lado positivo vence por prioridade ou origem, `raw = clamp(agregado positivo, 0, 1)`.
- Com `conflictResolution: "margin"`, `raw = clamp(agregado positivo - agregado negativo, 0, 1)`.
- O valor é `min + raw * (max - min)`, encaixado no `step`.

A resposta traz `basis: "rescaled-cosine"`, `support` e `oppose`. Isso é uma reescala do agregado ou da folga entre agregados. Não é nível calibrado, não é probabilidade e não é confiança estatística. Trocar o modelo muda esses números sem que o State tenha mudado.

Quando a evidência negativa domina por prioridade ou origem, o valor encosta em `min`. Isso registra oposição acima do limiar, não falta de conhecimento.

## Limiares

Os padrões não são uma calibração do MiniLM nem uma regra de 50%:

- `minSimilarity`: 0.72
- `evidenceMargin`: 0.05
- `contradictionMargin`: 0.05
- `choiceMargin`: 0.04
- `topK`: 8
- `choiceEvidenceWeight`: 0.15
- `aggregation`: `sum`
- `conflictResolution`: `priority`
- `relationWeight`: 0

Passe um parcial no construtor. Os testes do motor usam vetores plantados e limiares explícitos. Com um modelo real, meça paráfrases, temas sem relação, opções parecidas e pares positivo/negativo antes de fixar os números.

`topK` limita o que a decisão enxerga. Uma evidência contraditória fora desse recorte não entra na conta.

`choiceEvidenceWeight` 0 ignora o State na ordenação das opções. Um peso alto deixa o conhecimento superar a proximidade entre pergunta e opção. O portão `minSimilarity` continua valendo para a opção escolhida.

Margem 0 faz uma folga nula deixar de ser contradição quando `conflictResolution` é `margin`. No padrão `priority`, dois lados relevantes ficam `UNDETERMINED` até que prioridade ou origem os separe.

## State estruturado

O mesmo State responde várias perguntas sem reenviar o conhecimento. A versão começa em 1 e sobe a cada mutação. `decide` não altera a versão.

Além do conhecimento, o State guarda domínio, metadados, categorias, relações e restrições. Cada conhecimento pode ter categorias, peso, prioridade e origem. Trocar só esses campos não gera embedding de novo.

Relações: `supports`, `contradicts`, `depends-on` e `refines`. Com `relationWeight` maior que zero, `supports` aumenta a relevância do destino. `contradicts` abre conflito. As outras duas ficam registradas e não mudam o voto.

Restrições:

- `minimum-evidence`: quantidade mínima de itens elegíveis.
- `prefer-source`: lista ordenada de origens. A primeira vence.
- `minimum-priority`: ignora conhecimento abaixo do piso.

Uma restrição com categorias só vale para pergunta que cruze essas categorias.

## Evidência, explicação e estratégias

Cada resposta traz `explanation`: pergunta, State e versão, modelo, estratégia e versão, limiares, conhecimentos recuperados, evidências favoráveis e contrárias, conflitos, cálculos, critérios e resultado.

A decisão não usa só o item de maior cosseno. As estratégias prontas são cosseno, relevância ponderada, agregação, polaridade, margem, regras e a composição híbrida usada por Noul, Choice e Score. Uma estratégia nova implementa `type`, `version` e `decide`.

## Perguntas compostas

`when` referencia uma pergunta anterior da mesma requisição. Se a decisão dela não estiver em `decisions`, a resposta é `SKIPPED` / `CONDITION_NOT_MET` e a estratégia não roda. Isso não gera texto nem interpreta a pergunta.

## Avaliação

`evaluateDecisions` compara um conjunto rotulado. `YES` é a classe positiva de precisão, recall, falso positivo e falso negativo. `UNDETERMINED` só acerta quando o rótulo também é indeterminado. A taxa de indeterminados é separada.

`calibrateThresholds` percorre uma grade no próprio conjunto. O limiar escolhido é otimista para esses dados. Similaridade não vira probabilidade. Não há calibração de Platt.

## Auditoria

Passe um `AuditLog` para a engine. `InMemoryAuditLog` guarda o pedido, a resposta, a versão do State, o modelo, as versões das estratégias, os limiares e os conhecimentos recuperados. `replay` recalcula com esses dados, sem chamar o provider de embeddings, e informa se State, modelo ou estratégia mudaram desde o registro.

## Estratégia personalizada

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
    { id: "q", type: "presence", question: "Há conhecimento relacionado?" }
  ]
});
```

Registrar o mesmo `type` duas vezes lança erro. `noul`, `choice` e `score` já estão registrados. Se a estratégia não devolver `explanation`, a engine grava uma explicação mínima com o resultado.

O contexto traz a pergunta, o vetor da pergunta, o State estruturado, o modelo, a medida de similaridade, os conhecimentos pontuados, os vetores das opções de choice e os limiares. `assessEvidence`, `judgeEvidence`, `vote`, `polarityPeaks` e `cosineSimilarity` são exportados.

Uma estratégia nova recebe o vetor da pergunta e as evidências. As descrições de opções só são embutidas automaticamente quando `type` é `choice`.

## Exemplos

Os quatro primeiros rodam sem download de modelo:

```bash
npm run example:basic
npm run example:salon
npm run example:states
npm run example:custom
```

`npm run example:salon-local` usa o Transformers local. Exige `@huggingface/transformers` e o download do modelo. Os números variam com o modelo. A negação escrita só na pergunta não é tratada como operador lógico.

## Testes

```bash
npm test
npm run build
```

A suíte unitária planta vetores e cobre paráfrase, palavras diferentes com o mesmo vetor, polaridade negativa, contradição, pergunta sem relação, State vazio, alternativas parecidas, alternativas separadas, isolamento entre States, dimensão incompatível e modelo incompatível. Também cobre falso positivo abaixo do limiar e o caso em que a palavra "não" na pergunta não inverte o voto.

A integração com o modelo local fica desligada até:

```bash
RUN_EMBEDDING_INTEGRATION=1 npm test
```

Ela compara faixas de cosseno. Não exige uma decisão exata do MiniLM.

## Limitações

- Cosseno mede proximidade no espaço do modelo. Ele não descobre sozinho negação, causa ou implicação. Contradição entra quando a polaridade ou uma relação `contradicts` está no State.
- Esta versão não classifica a pergunta. Quem precisa do voto invertido informa `polarity: "negative"`.
- Conhecimento neutro não vota. Conhecimento sem polaridade explícita deve ser gravado como `positive`, `negative` ou `neutral` por quem conhece o domínio.
- Score é reescala de agregado ou de folga. Não publique esse número como confiança.
- Os limiares padrão são ponto de partida. A grade de calibração no mesmo conjunto usado para medir é otimista.
- `topK` pode ocultar evidência mais fraca.
- A coluna `vector(N)` do Postgres não é alterada por este pacote. Colunas novas do State entram com `ADD COLUMN` e valor padrão.
- O provider local é pesado e baixa arquivos na primeira execução. Testes e exemplos determinísticos não dependem dele.

## Publicação

O pacote é ESM, com `types` e `exports` para `.`, `./pgvector` e `./testing`. `npm run build` gera `dist` com declarações. `@huggingface/transformers` e `pg` ficam como peer dependencies opcionais.
