import type { Polarity } from "../core/types/knowledge.js";
import {
  IncompatibleDimensionsError,
  InvalidDecisionError,
  InvalidVectorError,
} from "../core/errors/index.js";

const POLARITIES = new Set<Polarity>(["positive", "negative", "neutral"]);

export function assertPolarity(value: string): asserts value is Polarity {
  if (!POLARITIES.has(value as Polarity)) {
    throw new InvalidDecisionError(
      `Invalid polarity: ${value}. Use positive, negative, or neutral.`,
    );
  }
}

export function assertValidVector(
  vector: number[],
  expectedDimensions: number,
): void {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new InvalidVectorError("Empty vector.");
  }
  if (!Number.isInteger(expectedDimensions) || expectedDimensions < 1) {
    throw new InvalidVectorError("Invalid expected dimension.");
  }
  if (vector.length !== expectedDimensions) {
    throw new IncompatibleDimensionsError(expectedDimensions, vector.length);
  }

  let norm = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new InvalidVectorError("Vector contains a non-finite value.");
    }
    norm += value * value;
  }

  if (norm === 0) {
    throw new InvalidVectorError("A zero vector cannot be stored.");
  }
}

export function assertJsonValue(value: unknown, label: string): void {
  try {
    JSON.stringify(value);
  } catch {
    throw new InvalidDecisionError(`${label} must be JSON-serializable.`);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export function parseVectorLiteral(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const parsed = typeof item === "number" ? item : Number(item);
      if (!Number.isFinite(parsed)) {
        throw new InvalidVectorError("Returned embedding contains a non-finite value.");
      }
      return parsed;
    });
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const body = trimmed.slice(1, -1).trim();
      if (body.length === 0) {
        return [];
      }
      return body.split(",").map((part) => {
        const parsed = Number(part.trim());
        if (!Number.isFinite(parsed)) {
          throw new InvalidVectorError("Returned embedding contains a non-finite value.");
        }
        return parsed;
      });
    }
  }

  throw new InvalidVectorError(
    "Could not read the embedding returned by storage.",
  );
}
