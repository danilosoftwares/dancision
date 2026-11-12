import type { EmbeddingProvider } from "../../core/interfaces/embedding-provider.js";
import {
  EmbeddingProviderError,
  IncompatibleDimensionsError,
  InvalidDecisionError,
} from "../../core/errors/index.js";

export const DEFAULT_TRANSFORMERS_MODEL =
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const DEFAULT_TRANSFORMERS_DIMENSIONS = 384;

export type TransformersDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export interface TransformersEmbeddingProviderOptions {
  model?: string;
  dimensions?: number;
  dtype?: TransformersDtype;
}

interface FeatureExtractionOutput {
  data?: ArrayLike<number>;
  dims?: number[];
  tolist?: () => unknown;
}

interface FeatureExtractionPipeline {
  (
    input: string | string[],
    options: { pooling: "mean"; normalize: boolean },
  ): Promise<FeatureExtractionOutput>;
}

interface TransformersModule {
  pipeline?: (
    task: "feature-extraction",
    model: string,
    options?: { dtype?: TransformersDtype },
  ) => Promise<FeatureExtractionPipeline>;
  default?: {
    pipeline?: TransformersModule["pipeline"];
  };
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly model: string;
  private readonly dtype: TransformersDtype;
  private pipelineTask: Promise<FeatureExtractionPipeline> | null = null;

  constructor(options: TransformersEmbeddingProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_TRANSFORMERS_MODEL;
    this.dtype = options.dtype ?? "q8";
    this.dimensions = options.dimensions ?? DEFAULT_TRANSFORMERS_DIMENSIONS;
    if (!Number.isInteger(this.dimensions) || this.dimensions < 1) {
      throw new InvalidDecisionError("dimensions must be a positive integer.");
    }
    if (this.model.trim().length === 0) {
      throw new InvalidDecisionError("The embedding model name is empty.");
    }
    this.modelId = `${this.model}:${this.dtype}`;
  }

  async generate(text: string): Promise<number[]> {
    const [vector] = await this.generateBatch([text]);
    if (!vector) {
      throw new EmbeddingProviderError("The local model did not return the embedding.");
    }
    return vector;
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const extractor = await this.getPipeline();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const vectors = readVectors(output, texts.length, this.dimensions);
    if (vectors.length !== texts.length) {
      throw new EmbeddingProviderError(
        "The local model returned a different number of vectors than texts.",
      );
    }
    return vectors;
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelineTask) {
      this.pipelineTask = loadPipeline(this.model, this.dtype).catch((error: unknown) => {
        this.pipelineTask = null;
        throw error;
      });
    }
    return this.pipelineTask;
  }
}

async function loadPipeline(
  model: string,
  dtype: TransformersDtype,
): Promise<FeatureExtractionPipeline> {
  let imported: TransformersModule;
  try {
    const moduleName = "@huggingface/transformers";
    imported = (await import(moduleName)) as TransformersModule;
  } catch {
    throw new EmbeddingProviderError(
      "Package @huggingface/transformers is not installed. Install it to use TransformersEmbeddingProvider.",
    );
  }

  const pipeline = imported.pipeline ?? imported.default?.pipeline;
  if (!pipeline) {
    throw new EmbeddingProviderError(
      "Could not load pipeline from @huggingface/transformers.",
    );
  }

  return pipeline("feature-extraction", model, { dtype });
}

function readVectors(
  output: FeatureExtractionOutput,
  expectedCount: number,
  expectedDimensions: number,
): number[][] {
  if (output.dims && output.data) {
    return vectorsFromTensor(output.data, output.dims, expectedDimensions);
  }

  if (output.tolist) {
    return vectorsFromList(output.tolist(), expectedCount, expectedDimensions);
  }

  throw new EmbeddingProviderError(
    "The local model output does not contain an embedding tensor.",
  );
}

function vectorsFromTensor(
  data: ArrayLike<number>,
  dims: number[],
  expectedDimensions: number,
): number[][] {
  if (dims.length === 1) {
    const width = dims[0] ?? 0;
    assertWidth(expectedDimensions, width);
    return [Array.from(data)];
  }

  if (dims.length === 2) {
    const rows = dims[0] ?? 0;
    const width = dims[1] ?? 0;
    assertWidth(expectedDimensions, width);
    const vectors: number[][] = [];
    for (let row = 0; row < rows; row += 1) {
      const start = row * width;
      const vector: number[] = [];
      for (let column = 0; column < width; column += 1) {
        vector.push(Number(data[start + column]));
      }
      vectors.push(vector);
    }
    return vectors;
  }

  throw new EmbeddingProviderError(
    `Unsupported tensor shape: ${dims.join("x")}.`,
  );
}

function vectorsFromList(
  value: unknown,
  expectedCount: number,
  expectedDimensions: number,
): number[][] {
  if (!Array.isArray(value)) {
    throw new EmbeddingProviderError("The local model output is not a list of vectors.");
  }

  if (value.length > 0 && typeof value[0] === "number") {
    assertWidth(expectedDimensions, value.length);
    return [value.map((item) => Number(item))];
  }

  if (value.length !== expectedCount) {
    throw new EmbeddingProviderError(
      "The local model returned a different number of vectors than texts.",
    );
  }

  return value.map((row) => {
    if (!Array.isArray(row)) {
      throw new EmbeddingProviderError("The local model output is not a list of vectors.");
    }
    assertWidth(expectedDimensions, row.length);
    return row.map((item) => Number(item));
  });
}

function assertWidth(expected: number, actual: number): void {
  if (actual !== expected) {
    throw new IncompatibleDimensionsError(expected, actual);
  }
}
