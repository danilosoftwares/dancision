import type { ScoredKnowledge } from "../../core/interfaces/vector-store.js";
import type { EvidenceItem, QuestionPolarity, SimilarityBreakdown } from "../../core/types/decision.js";
import type { DecisionThresholds } from "../../core/types/thresholds.js";

export interface VotingSides {
  support: number;
  oppose: number;
  supportItems: ScoredKnowledge[];
  opposeItems: ScoredKnowledge[];
  eligible: ScoredKnowledge[];
}

export type EvidenceVerdict =
  | { kind: "no-evidence" }
  | { kind: "insufficient" }
  | { kind: "contradictory" }
  | { kind: "support" }
  | { kind: "oppose" };

export function polarityPeaks(items: ScoredKnowledge[]): SimilarityBreakdown {
  let positive = 0;
  let negative = 0;
  for (const item of items) {
    if (item.polarity === "positive") {
      positive = Math.max(positive, item.similarity);
    } else if (item.polarity === "negative") {
      negative = Math.max(negative, item.similarity);
    }
  }
  return { positive, negative };
}

export function vote(
  items: ScoredKnowledge[],
  thresholds: DecisionThresholds,
  questionPolarity: QuestionPolarity,
): VotingSides {
  const eligible = items.filter(
    (item) =>
      item.similarity >= thresholds.minSimilarity &&
      (item.polarity === "positive" || item.polarity === "negative"),
  );
  const positiveItems = eligible.filter((item) => item.polarity === "positive");
  const negativeItems = eligible.filter((item) => item.polarity === "negative");
  const positivePeak = maxSimilarity(positiveItems);
  const negativePeak = maxSimilarity(negativeItems);

  if (questionPolarity === "negative") {
    return {
      support: negativePeak,
      oppose: positivePeak,
      supportItems: negativeItems,
      opposeItems: positiveItems,
      eligible,
    };
  }

  return {
    support: positivePeak,
    oppose: negativePeak,
    supportItems: positiveItems,
    opposeItems: negativeItems,
    eligible,
  };
}

export function judgeEvidence(
  items: ScoredKnowledge[],
  voting: VotingSides,
  thresholds: DecisionThresholds,
): EvidenceVerdict {
  if (items.length === 0) {
    return { kind: "no-evidence" };
  }
  if (voting.eligible.length === 0) {
    return { kind: "insufficient" };
  }

  const bothSides = voting.supportItems.length > 0 && voting.opposeItems.length > 0;
  const gap = Math.abs(voting.support - voting.oppose);
  if (bothSides && gap < thresholds.contradictionMargin) {
    return { kind: "contradictory" };
  }

  if (
    voting.supportItems.length > 0 &&
    voting.support - voting.oppose >= thresholds.evidenceMargin
  ) {
    return { kind: "support" };
  }

  if (
    voting.opposeItems.length > 0 &&
    voting.oppose - voting.support >= thresholds.evidenceMargin
  ) {
    return { kind: "oppose" };
  }

  return { kind: "insufficient" };
}

export function toEvidence(items: ScoredKnowledge[]): EvidenceItem[] {
  return items
    .slice()
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        left.knowledgeId.localeCompare(right.knowledgeId),
    )
    .map((item) => ({
      knowledgeId: item.knowledgeId,
      content: item.content,
      similarity: item.similarity,
      polarity: item.polarity,
      relevance: item.similarity * (item.weight ?? 1),
      weight: item.weight ?? 1,
      priority: item.priority ?? 0,
      side:
        item.polarity === "negative"
          ? ("contrary" as const)
          : item.polarity === "positive"
            ? ("favorable" as const)
            : ("neutral" as const),
      ...(item.source === undefined ? {} : { source: item.source }),
      ...(item.categories === undefined ? {} : { categories: item.categories }),
    }));
}

function maxSimilarity(items: ScoredKnowledge[]): number {
  let max = 0;
  for (const item of items) {
    if (item.similarity > max) {
      max = item.similarity;
    }
  }
  return max;
}
