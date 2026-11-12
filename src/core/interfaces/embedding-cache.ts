export interface EmbeddingCache {
  get(key: string): Promise<number[] | null> | number[] | null;
  set(key: string, vector: number[]): Promise<void> | void;
}
