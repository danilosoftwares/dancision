export const WEIGHTED_SIMILARITY_VERSION = "1.0.0";

export function weightedRelevance(similarity: number, weight = 1): number {
  return similarity * weight;
}
