import type { DecisionStrategy } from "../core/interfaces/decision-strategy.js";
import { InvalidDecisionError } from "../core/errors/index.js";

export class DecisionRegistry {
  private readonly strategies = new Map<string, DecisionStrategy>();

  register(strategy: DecisionStrategy): void {
    if (!strategy.type || strategy.type.trim().length === 0) {
      throw new InvalidDecisionError("Strategy is missing a type.");
    }
    if (!strategy.version || strategy.version.trim().length === 0) {
      throw new InvalidDecisionError("Strategy is missing a version.");
    }
    if (this.strategies.has(strategy.type)) {
      throw new InvalidDecisionError(
        `A strategy for type "${strategy.type}" is already registered.`,
      );
    }
    this.strategies.set(strategy.type, strategy);
  }

  get(type: string): DecisionStrategy {
    const strategy = this.strategies.get(type);
    if (!strategy) {
      throw new InvalidDecisionError(`Unknown decision type: ${type}`);
    }
    return strategy;
  }

  list(): DecisionStrategy[] {
    return [...this.strategies.values()];
  }
}
