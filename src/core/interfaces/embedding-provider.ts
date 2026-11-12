export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  generate(text: string): Promise<number[]>;
  generateBatch?(texts: string[]): Promise<number[][]>;
}
