import { describe, expect, it } from "vitest";
import { snapToScale } from "../../src/decisions/score/scale.ts";
import {
  InvalidDecisionError,
  InvalidThresholdError,
  resolveThresholds,
  validateScale,
} from "../../src/index.ts";

describe("thresholds and scale", () => {
  it("keeps the defaults when there is no override", () => {
    expect(resolveThresholds().minSimilarity).toBe(0.72);
    expect(resolveThresholds().topK).toBe(8);
  });

  it("rejects a threshold outside the cosine interval", () => {
    expect(() => resolveThresholds({ minSimilarity: 1.2 })).toThrow(InvalidThresholdError);
  });

  it("rejects a negative margin and an invalid topK", () => {
    expect(() => resolveThresholds({ evidenceMargin: -0.1 })).toThrow(InvalidThresholdError);
    expect(() => resolveThresholds({ topK: 0 })).toThrow(InvalidThresholdError);
  });

  it("rejects an inverted scale", () => {
    expect(() => validateScale({ min: 10, max: 10, step: 1 })).toThrow(InvalidDecisionError);
    expect(() => validateScale({ min: 0, max: 10, step: 0 })).toThrow(InvalidDecisionError);
  });

  it("snaps the value to the step without treating the number as a probability", () => {
    const scale = { min: 0, max: 100, step: 10 };
    expect(snapToScale(94, scale)).toBe(90);
    expect(snapToScale(100, scale)).toBe(100);
    expect(snapToScale(0, scale)).toBe(0);
  });
});
