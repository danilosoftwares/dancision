import type { ScoreScale } from "../../core/types/decision.js";
import { clamp } from "../../utils/vector.js";

export function snapToScale(value: number, scale: ScoreScale): number {
  const steps = Math.round((value - scale.min) / scale.step);
  const snapped = clamp(scale.min + steps * scale.step, scale.min, scale.max);
  const decimals = decimalPlaces(scale.step);
  return Number(snapped.toFixed(Math.min(decimals + 2, 12)));
}

function decimalPlaces(step: number): number {
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) {
    const exponent = Number(text.split("e-")[1]);
    return Number.isFinite(exponent) ? exponent : 0;
  }
  const fraction = text.split(".")[1];
  return fraction?.length ?? 0;
}
