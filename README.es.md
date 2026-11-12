# dancision

[English](README.md) | [Português](README.pt-BR.md) | Español | [中文](README.zh-CN.md)

Framework de decisión semántica para Node.js. Recibe un State, una o más preguntas y, cuando hace falta, opciones de respuesta. La decisión sale de embeddings, similitud de coseno y umbrales. Ningún LLM generativo interpreta la pregunta, elige la alternativa ni asigna el score.

## Instalación

```bash
npm install dancision
```

El núcleo no instala modelo ni base de datos. Los adaptadores son dependencias opcionales:

```bash
npm install @huggingface/transformers
npm install pg
```

Node.js 20 o superior.

## Arquitectura

```text
preguntas y opciones
        |
        v
EmbeddingProvider  --->  solo estos textos se vectorizan en la consulta
        |
        v
VectorStore.search(stateId)  --->  vectores de conocimiento ya guardados
        |
        v
DecisionStrategy (noul | choice | score | tipo propio)
```

| Pieza | Responsabilidad |
| --- | --- |
| `EmbeddingProvider` | Genera vectores. El núcleo no conoce el modelo. |
| `StateRepository` | Guarda nombre, descripción, texto, polaridad, hash y la versión del modelo. |
| `VectorStore` | Guarda y busca vectores, siempre filtrando por State. |
| `StateManager` | Crea, actualiza, agrega, elimina y reprocesa. Coordina los dos almacenes. |
| `DecisionEngine` | Embebe la consulta, recupera evidencias y despacha la estrategia. |
| `DecisionStrategy` | Aplica la regla matemática de un tipo de decisión. |

Una consulta no altera el State y no usa respuestas anteriores. Para cambiar el modelo o la dimensión, llama `states.reprocess(stateId)`. La consulta falla si los vectores guardados no coinciden con el provider actual.

## State y Knowledge

El State es el contexto. Cada conocimiento tiene su propio embedding. El State entero nunca es un único vector.

```typescript
await engine.states.create({
  id: "salon-erp",
  name: "ERP para salón de belleza",
  description: "Sistema de gestión para salones de belleza",
  knowledge: [
    { id: "k1", content: "El sistema permite crear citas.", polarity: "positive" },
    { id: "k2", content: "El sistema permite cancelar citas.", polarity: "positive" },
    { id: "k3", content: "El sistema no permite pagos recurrentes.", polarity: "negative" }
  ]
});
```

`polarity` la informa quien escribe el conocimiento:

- `positive`: el texto afirma la capacidad o el hecho.
- `negative`: el texto niega la capacidad o el hecho.
- `neutral`: entra en la búsqueda, pero no vota.

La polaridad no se deduce del texto. Dos textos cercanos pueden tener polaridades opuestas. La decisión usa el campo, no la intuición del modelo.

Los conocimientos de States distintos no se mezclan. La búsqueda siempre recibe `stateId`.

Operaciones:

- `states.create`
- `states.update` para nombre y descripción
- `states.addKnowledge`
- `states.updateKnowledge` para contenido, polaridad o metadata
- `states.removeKnowledge`
- `states.reprocess`
- `states.get`
- `states.delete`

El embedding del conocimiento se genera de nuevo solo cuando se crea el State, se agrega un conocimiento, cambia `content` o se llama `reprocess`. Cambiar solo la polaridad reescribe el metadato y reutiliza el vector. La consulta genera embeddings de las preguntas y de las descripciones de las opciones.

Cada vector guarda `modelId`, `dimensions` y el hash SHA-256 del contenido. Una dimensión o un modelo distinto interrumpe la consulta con `IncompatibleDimensionsError` o `IncompatibleModelError`.

## Embeddings

```typescript
interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  generate(text: string): Promise<number[]>;
  generateBatch?(texts: string[]): Promise<number[][]>;
}
```

`modelId` entra en la clave de caché y en la comparación con los vectores guardados. Incluye el modelo y el dtype, o cualquier versión que deba invalidar los vectores antiguos.

Si existe `generateBatch`, los textos que aún no están en caché salen en una sola llamada. Los textos repetidos del mismo lote se embeben una vez. Sin lote, el servicio llama `generate` en secuencia.

`InMemoryEmbeddingCache` es opcional. La clave es `modelId` más el hash del texto. La caché no sustituye al VectorStore: el conocimiento persistido no se genera otra vez en la consulta.

Un vector vacío, nulo, no finito o con dimensión distinta de la declarada se rechaza antes de guardarse o compararse.

## Provider local

`TransformersEmbeddingProvider` carga `@huggingface/transformers` solo en la primera generación.

```typescript
import { TransformersEmbeddingProvider } from "dancision";

const embeddings = new TransformersEmbeddingProvider({
  model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  dimensions: 384,
  dtype: "q8"
});
```

El valor por defecto es ese modelo, 384 dimensiones, pooling mean y vector normalizado. El mismo espacio vale para conocimiento, pregunta y opción, sin prefijo de query ni passage. Si cambias el modelo, informa `dimensions` con el tamaño real de la salida. Una divergencia entre el tensor y la configuración lanza un error. `modelId` queda `{modelo}:{dtype}`.

El primer uso descarga el modelo. Eso exige red y espacio en disco.

## Provider propio

Implementa la interfaz e inyéctala en la engine. El ejemplo `examples/custom-provider` reparte tokens en un vector fijo. Muestra el contrato. No es un modelo semántico.

Los tests usan `DeterministicEmbeddingProvider`, exportado en `dancision/testing`, con vectores plantados. La decisión es reproducible sin modelo.

## PostgreSQL y pgvector

El núcleo no importa `pg`. El subpath opcional es `dancision/pgvector`.

Requisitos:

- PostgreSQL con la extensión `vector`.
- pgvector 0.5 o superior, por el índice HNSW.
- Un rol que pueda crear la extensión, o la extensión ya creada.

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

La primera operación crea, si todavía no existen:

- `sde_states`, con el State y la lista de conocimientos en `jsonb`.
- `sde_knowledge`, con `embedding vector(384)`, polaridad y hash.
- un índice HNSW `vector_cosine_ops`.

La migración es idempotente. Usa `CREATE EXTENSION IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS` y `CREATE INDEX IF NOT EXISTS`. No ejecuta `DROP` ni `ALTER` de la columna vectorial. Si la tabla ya existe con otra dimensión, la operación lanza `SchemaMismatchError` y la tabla permanece como está. En ese caso usa otro `tablePrefix` u otra base. La dimensión de `vector(N)` queda fija al crear la tabla. Las columnas nuevas del State entran con `ADD COLUMN` y un valor por defecto.

La búsqueda filtra `state_id` y `model_id`, ordena por distancia de coseno y acepta `limit`. Los identificadores de schema y prefijo solo aceptan letras, números y `_`.

`createPgPool` también está exportado, si quieres controlar el ciclo del pool. `db.end()` cierra la conexión cuando el pool fue creado por ese helper.

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
      question: "¿Se puede cancelar una cita ya agendada?"
    },
    {
      id: "action",
      type: "choice",
      question: "¿Qué operación de agenda se está solicitando?",
      options: [
        { id: "create", description: "Crear cita" },
        { id: "cancel", description: "Cancelar cita" },
        { id: "update", description: "Cambiar cita" }
      ]
    }
  ]
});
```

Los números de abajo son ilustrativos. La similitud no es confianza ni probabilidad.

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
          content: "El sistema permite cancelar citas.",
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

En choice, `similarity` es el coseno entre la pregunta y la descripción de la opción. `rankingScore` suma el ajuste del State y puede salir del intervalo [-1, 1]. `evidenceScore` es la media de ese ajuste. Ninguno de esos campos es una probabilidad.

Toda respuesta incluye también `explanation`.

## Tipos de decisión

### Noul

Responde `YES`, `NO` o `UNDETERMINED`.

1. La búsqueda trae hasta `topK` conocimientos del State.
2. `similarity.positive` y `similarity.negative` son los mayores cosenos de cada polaridad, incluso por debajo del umbral.
3. Solo vota un ítem con coseno mayor o igual a `minSimilarity`, peso mayor que cero y categoría compatible con la pregunta. Lo neutro no vota. La relevancia es coseno por peso.
4. La agregación por defecto suma las relevancias de cada lado. `mean` y `peak` son alternativas. La suma puede pasar de 1 y no es una probabilidad.
5. Si la pregunta llega con `polarity: "negative"`, los lados se intercambian. Sin ese campo, la pregunta se trata como afirmativa. El texto de la pregunta no se clasifica.
6. Cuando los dos lados son relevantes, con la misma prioridad y sin un origen que los separe, el resultado es `UNDETERMINED` / `CONTRADICTORY`. La mayor similitud no elige el lado.
7. La prioridad mayor, o el origen anterior en `prefer-source`, se queda con el voto. `conflictResolution: "margin"` restaura la regla anterior: una holgura menor que `contradictionMargin` es contradicción; si no, gana el agregado mayor cuando la holgura alcanza `evidenceMargin`.
8. Un State vacío produce `NO_EVIDENCE`. Ítems recuperados, pero todos por debajo del umbral, producen `INSUFFICIENT_EVIDENCE`.

La ausencia de conocimiento no es `NO`.

`polarity: "negative"` en la pregunta existe para que quien llama declare que la frase pide la negación. La doble negación y las relaciones lógicas compuestas quedan fuera de esta versión. Una relación `contradicts` entre dos conocimientos elegibles también es un conflicto. Sin prioridad u origen que los separe, el resultado es `UNDETERMINED`.

### Choice

Compara la pregunta con cada descripción de opción.

- `base` es el coseno pregunta-opción.
- Entre los conocimientos de la pregunta que pasaron el umbral, `evidenceScore` es la media de coseno(opción, conocimiento) con el signo de la polaridad. Sin evidencia, el ajuste es 0.
- `rankingScore = base + choiceEvidenceWeight * evidenceScore`.
- `SELECTED` exige que la opción ganadora tenga `base >= minSimilarity` y que la holgura de `rankingScore` respecto de la segunda sea mayor o igual a `choiceMargin`.
- Holgura insuficiente: `AMBIGUOUS`.
- Mejor base por debajo del umbral: `WEAK_MATCH`.

El conocimiento puede cambiar el orden, pero no elige una opción semánticamente lejana de la pregunta. Alternativas casi sinónimas permanecen indeterminadas cuando el margen no las separa.

### Score

Escala `{ min, max, step }`, con `min < max` y `step > 0`.

- Sin evidencia por encima del umbral: `UNDETERMINED`. Un State vacío usa `NO_EVIDENCE`. Ítems recuperados por debajo del umbral usan `INSUFFICIENT_EVIDENCE`. El valor no se rellena. La ausencia no se vuelve 0.
- Contradicción sin criterio de prioridad, origen o margen: `UNDETERMINED` / `CONTRADICTORY`.
- Si el lado positivo gana por prioridad u origen, `raw = clamp(agregado positivo, 0, 1)`.
- Con `conflictResolution: "margin"`, `raw = clamp(agregado positivo - agregado negativo, 0, 1)`.
- El valor es `min + raw * (max - min)`, encajado en el `step`.

La respuesta trae `basis: "rescaled-cosine"`, `support` y `oppose`. Es una reescala del agregado o de la holgura entre agregados. No es un nivel calibrado, no es una probabilidad y no es confianza estadística. Cambiar el modelo cambia esos números aunque el State no haya cambiado.

Cuando la evidencia negativa domina por prioridad u origen, el valor se apoya en `min`. Eso registra oposición por encima del umbral, no falta de conocimiento.

## Umbrales

Los valores por defecto no son una calibración del MiniLM ni una regla del 50%:

- `minSimilarity`: 0.72
- `evidenceMargin`: 0.05
- `contradictionMargin`: 0.05
- `choiceMargin`: 0.04
- `topK`: 8
- `choiceEvidenceWeight`: 0.15
- `aggregation`: `sum`
- `conflictResolution`: `priority`
- `relationWeight`: 0

Pasa un objeto parcial al constructor. Los tests del motor usan vectores plantados y umbrales explícitos. Con un modelo real, mide paráfrasis, temas sin relación, opciones parecidas y pares positivo/negativo antes de fijar los números.

`topK` limita lo que ve la decisión. Una evidencia contradictoria fuera de ese recorte no entra en la cuenta.

`choiceEvidenceWeight` 0 ignora el State al ordenar las opciones. Un peso alto deja que el conocimiento supere la proximidad entre pregunta y opción. La puerta `minSimilarity` sigue valiendo para la opción elegida.

Un margen 0 hace que una holgura nula deje de ser contradicción cuando `conflictResolution` es `margin`. Con el valor por defecto `priority`, dos lados relevantes quedan `UNDETERMINED` hasta que la prioridad o el origen los separe.

## State estructurado

El mismo State responde varias preguntas sin reenviar el conocimiento. La versión empieza en 1 y sube en cada mutación. `decide` no altera la versión.

Además del conocimiento, el State guarda dominio, metadatos, categorías, relaciones y restricciones. Cada conocimiento puede tener categorías, peso, prioridad y origen. Cambiar solo esos campos no genera un embedding de nuevo.

Relaciones: `supports`, `contradicts`, `depends-on` y `refines`. Con `relationWeight` mayor que cero, `supports` aumenta la relevancia del destino. `contradicts` abre un conflicto. Las otras dos quedan registradas y no cambian el voto.

Restricciones:

- `minimum-evidence`: cantidad mínima de ítems elegibles.
- `prefer-source`: lista ordenada de orígenes. El primero gana.
- `minimum-priority`: ignora el conocimiento por debajo del piso.

Una restricción con categorías solo vale para una pregunta que cruce esas categorías.

## Evidencia, explicación y estrategias

Cada respuesta trae `explanation`: pregunta, State y versión, modelo, estrategia y versión, umbrales, conocimientos recuperados, evidencias favorables y contrarias, conflictos, cálculos, criterios y resultado.

La decisión no usa solo el ítem de mayor coseno. Las estrategias incluidas son coseno, relevancia ponderada, agregación, polaridad, margen, reglas y la composición híbrida usada por Noul, Choice y Score. Una estrategia nueva implementa `type`, `version` y `decide`.

## Preguntas compuestas

`when` referencia una pregunta anterior de la misma petición. Si la decisión de esa pregunta no está en `decisions`, la respuesta es `SKIPPED` / `CONDITION_NOT_MET` y la estrategia no corre. Esto no genera texto ni interpreta la pregunta.

## Evaluación

`evaluateDecisions` compara un conjunto etiquetado. `YES` es la clase positiva de precisión, recall, falso positivo y falso negativo. `UNDETERMINED` solo acierta cuando la etiqueta también es indeterminada. La tasa de indeterminados va aparte.

`calibrateThresholds` recorre una grilla en el propio conjunto. El umbral elegido es optimista para esos datos. La similitud no se vuelve probabilidad. No hay calibración de Platt.

## Auditoría

Pasa un `AuditLog` a la engine. `InMemoryAuditLog` guarda la petición, la respuesta, la versión del State, el modelo, las versiones de las estrategias, los umbrales y los conocimientos recuperados. `replay` recalcula con esos datos, sin llamar al provider de embeddings, e informa si el State, el modelo o la estrategia cambiaron desde el registro.

## Estrategia personalizada

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
    { id: "q", type: "presence", question: "¿Hay conocimiento relacionado?" }
  ]
});
```

Registrar el mismo `type` dos veces lanza un error. `noul`, `choice` y `score` ya están registrados. Si la estrategia no devuelve `explanation`, la engine guarda una explicación mínima con el resultado.

El contexto trae la pregunta, el vector de la pregunta, el State estructurado, el modelo, la medida de similitud, los conocimientos puntuados, los vectores de las opciones de choice y los umbrales. Se exportan `assessEvidence`, `judgeEvidence`, `vote`, `polarityPeaks` y `cosineSimilarity`.

Una estrategia nueva recibe el vector de la pregunta y las evidencias. Las descripciones de las opciones solo se embeben automáticamente cuando `type` es `choice`.

## Ejemplos

Los cuatro primeros corren sin descargar un modelo:

```bash
npm run example:basic
npm run example:salon
npm run example:states
npm run example:custom
```

`npm run example:salon-local` usa el Transformers local. Exige `@huggingface/transformers` y la descarga del modelo. Los números varían con el modelo. La negación escrita solo en la pregunta no se trata como operador lógico.

## Tests

```bash
npm test
npm run build
```

La suite unitaria planta vectores y cubre paráfrasis, palabras distintas con el mismo vector, polaridad negativa, contradicción, pregunta sin relación, State vacío, alternativas parecidas, alternativas separadas, aislamiento entre States, dimensión incompatible y modelo incompatible. También cubre el falso positivo por debajo del umbral y el caso en que la palabra "no" de la pregunta no invierte el voto.

La integración con el modelo local queda apagada hasta:

```bash
RUN_EMBEDDING_INTEGRATION=1 npm test
```

Compara rangos de coseno. No exige una decisión exacta del MiniLM.

## Limitaciones

- El coseno mide proximidad en el espacio del modelo. No descubre por sí solo negación, causa o implicación. La contradicción entra cuando la polaridad o una relación `contradicts` está en el State.
- Esta versión no clasifica la pregunta. Quien necesite el voto invertido informa `polarity: "negative"`.
- El conocimiento neutro no vota. Un conocimiento sin polaridad explícita debe guardarse como `positive`, `negative` o `neutral` por quien conoce el dominio.
- El score es una reescala de un agregado o de una holgura. No publiques ese número como confianza.
- Los umbrales por defecto son un punto de partida. La grilla de calibración sobre el mismo conjunto usado para medir es optimista.
- `topK` puede ocultar evidencia más débil.
- Este paquete no altera la columna `vector(N)` de Postgres. Las columnas nuevas del State entran con `ADD COLUMN` y un valor por defecto.
- El provider local es pesado y descarga archivos en la primera ejecución. Los tests y ejemplos determinísticos no dependen de él.

## Publicación

El paquete es ESM, con `types` y `exports` para `.`, `./pgvector` y `./testing`. `npm run build` genera `dist` con declaraciones. `@huggingface/transformers` y `pg` quedan como peer dependencies opcionales.
