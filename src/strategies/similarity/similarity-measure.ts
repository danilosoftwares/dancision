import { cosineSimilarity } from "../../utils/similarity.js";

export interface SimilarityMeasure {
  readonly id: string;
  readonly version: string;
  compare(left: number[], right: number[]): number;
}

export const cosineMeasure: SimilarityMeasure = {
  id: "cosine",
  version: "1.0.0",
  compare(left: number[], right: number[]): number {
    return cosineSimilarity(left, right);
  },
};
