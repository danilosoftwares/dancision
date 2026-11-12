import { IncompatibleDimensionsError, InvalidVectorError } from "../core/errors/index.js";

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new IncompatibleDimensionsError(left.length, right.length);
  }
  if (left.length === 0) {
    throw new InvalidVectorError("Empty vector.");
  }

  let dot = 0;
  let normLeft = 0;
  let normRight = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (
      leftValue === undefined ||
      rightValue === undefined ||
      !Number.isFinite(leftValue) ||
      !Number.isFinite(rightValue)
    ) {
      throw new InvalidVectorError("Vector contains a non-finite value.");
    }
    dot += leftValue * rightValue;
    normLeft += leftValue * leftValue;
    normRight += rightValue * rightValue;
  }

  if (normLeft === 0 || normRight === 0) {
    return 0;
  }

  const value = dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
  if (value > 1) {
    return 1;
  }
  if (value < -1) {
    return -1;
  }
  return value;
}
