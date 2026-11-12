import { describe, expect, it } from "vitest";
import {
  IncompatibleDimensionsError,
  InvalidVectorError,
  cosineSimilarity,
} from "../../src/index.ts";

describe("cosine similarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0, 0], [2, 0, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0, 0], [0, 1, 0, 0])).toBeCloseTo(0);
  });

  it("returns 0 when one vector is zero", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it("rejects different dimensions", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(IncompatibleDimensionsError);
  });

  it("rejects a non-finite value", () => {
    expect(() => cosineSimilarity([Number.NaN, 0], [1, 0])).toThrow(InvalidVectorError);
  });
});
