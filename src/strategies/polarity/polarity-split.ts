import type { Polarity } from "../../core/types/knowledge.js";
import type { QuestionPolarity } from "../../core/types/decision.js";

export const POLARITY_VERSION = "1.0.0";

export type EvidenceSide = "favorable" | "contrary" | "neutral";

export function polaritySide(
  polarity: Polarity,
  questionPolarity: QuestionPolarity,
): EvidenceSide {
  if (polarity === "neutral") {
    return "neutral";
  }
  const affirmativeFavorable = polarity === "positive";
  const favorable = questionPolarity === "negative" ? !affirmativeFavorable : affirmativeFavorable;
  return favorable ? "favorable" : "contrary";
}
