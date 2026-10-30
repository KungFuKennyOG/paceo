/**
 * "Why this workout" lines (spec §11.4) behind a small interface: the engine's deterministic
 * rule-trace templates (explain(trace, units)), in the user's units.
 */
import { explain, type Units } from "@paceo/engine";

export interface ExplainableWorkout {
  rule_trace?: readonly string[] | undefined;
}

export interface Explainer {
  explain(workout: ExplainableWorkout, units: Units): string[];
}

/** Raw rule IDs; for debugging and tests. */
export const ruleTraceExplainer: Explainer = {
  explain: (w) => [...(w.rule_trace ?? [])],
};

export const engineExplainer: Explainer = {
  explain: (w, units) => explain(w.rule_trace ?? [], units),
};

export function createDefaultExplainer(): Explainer {
  return engineExplainer;
}
