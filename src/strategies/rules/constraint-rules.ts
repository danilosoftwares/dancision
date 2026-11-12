import type { StateConstraint } from "../../core/types/state.js";

export const RULES_VERSION = "1.0.0";

export function applicableConstraints(
  constraints: StateConstraint[],
  questionCategories: string[] | undefined,
): StateConstraint[] {
  return constraints.filter((constraint) => {
    if (!constraint.categories || constraint.categories.length === 0) {
      return true;
    }
    if (!questionCategories || questionCategories.length === 0) {
      return false;
    }
    return constraint.categories.some((category) => questionCategories.includes(category));
  });
}

export function sourceRank(
  source: string | undefined,
  sources: string[],
): number | null {
  if (!source) {
    return null;
  }
  const index = sources.indexOf(source);
  return index < 0 ? null : index;
}

export function bestSourceRank(
  sources: Array<string | undefined>,
  preference: string[],
): number | null {
  let best: number | null = null;
  for (const source of sources) {
    const rank = sourceRank(source, preference);
    if (rank === null) {
      continue;
    }
    best = best === null ? rank : Math.min(best, rank);
  }
  return best;
}
